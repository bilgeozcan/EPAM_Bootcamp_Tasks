"use strict";

const { Pool } = require("pg");

const {
    SecretsManagerClient,
    GetSecretValueCommand
} = require("@aws-sdk/client-secrets-manager");

const REGION =
    process.env.REGION ||
    process.env.AWS_REGION ||
    "eu-west-1";

const DB_ENDPOINT = process.env.DB_ENDPOINT;
const SECRET_NAME = process.env.MASTER_USER_SECRET_NAME;
const DB_NAME = process.env.DB_NAME || "logisticdb";
const DB_PORT = Number(process.env.DB_PORT || 5432);

const secretsClient = new SecretsManagerClient({
    region: REGION
});

let poolPromise;

const SCHEMA_SQL = `
DO $$
BEGIN
    CREATE TYPE "StatusType" AS ENUM (
        'CREATED',
        'IN_TRANSIT',
        'DELAYED',
        'DELIVERED',
        'CANCELLED'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS shipments (
    shipment_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) NOT NULL,
    origin VARCHAR(100) NOT NULL,
    destination VARCHAR(100) NOT NULL,
    weight_kg NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS carriers (
    carrier_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    is_active BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS status_updates (
    update_id SERIAL PRIMARY KEY,
    shipment_id VARCHAR(50) NOT NULL,
    carrier_id VARCHAR(50) NOT NULL,
    status "StatusType" NOT NULL,
    location VARCHAR(100) NOT NULL,
    notes TEXT,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_status_shipment
        FOREIGN KEY (shipment_id)
        REFERENCES shipments(shipment_id)
        ON DELETE CASCADE,

    CONSTRAINT fk_status_carrier
        FOREIGN KEY (carrier_id)
        REFERENCES carriers(carrier_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_status_updates_shipment
    ON status_updates(shipment_id);

CREATE INDEX IF NOT EXISTS idx_status_updates_carrier
    ON status_updates(carrier_id);
`;

function apiResponse(statusCode, payload) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    };
}

function parseBody(event) {
    if (!event || event.body === undefined || event.body === null) {
        return {};
    }

    if (typeof event.body === "object") {
        return event.body;
    }

    if (event.body === "") {
        return {};
    }

    return JSON.parse(event.body);
}

async function createPool() {
    if (!DB_ENDPOINT) {
        throw new Error("DB_ENDPOINT environment variable is missing");
    }

    if (!SECRET_NAME) {
        throw new Error(
            "MASTER_USER_SECRET_NAME environment variable is missing"
        );
    }

    const secretResponse = await secretsClient.send(
        new GetSecretValueCommand({
            SecretId: SECRET_NAME
        })
    );

    if (!secretResponse.SecretString) {
        throw new Error("RDS master secret has no SecretString");
    }

    const secret = JSON.parse(secretResponse.SecretString);

    const pool = new Pool({
        host: DB_ENDPOINT,
        port: DB_PORT,
        database: DB_NAME,
        user: secret.username,
        password: secret.password,
        max: 4,
        min: 0,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10000,
        allowExitOnIdle: true
    });

    await pool.query("SELECT 1");

    return pool;
}

async function getPool() {
    if (!poolPromise) {
        poolPromise = createPool().catch((error) => {
            poolPromise = undefined;
            throw error;
        });
    }

    return poolPromise;
}

function requireFields(body, fields) {
    const missing = fields.filter((field) => {
        return body[field] === undefined ||
            body[field] === null ||
            body[field] === "";
    });

    if (missing.length > 0) {
        const error = new Error(
            `Missing required fields: ${missing.join(", ")}`
        );

        error.statusCode = 400;
        throw error;
    }
}

function shipmentResponse(row) {
    return {
        shipment_id: row.shipment_id,
        order_id: row.order_id,
        origin: row.origin,
        destination: row.destination,
        weight_kg: Number(row.weight_kg),
        created_at: row.created_at
    };
}

function carrierResponse(row) {
    return {
        carrier_id: row.carrier_id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        is_active: Boolean(row.is_active)
    };
}

function statusResponse(row) {
    return {
        update_id: Number(row.update_id),
        shipment_id: row.shipment_id,
        carrier_id: row.carrier_id,
        status: row.status,
        location: row.location,
        notes: row.notes,
        timestamp: row.timestamp
    };
}

async function initializeDatabase(pool) {
    await pool.query(SCHEMA_SQL);

    return apiResponse(200, {
        message: "Initialization is successful"
    });
}

async function getShipment(pool, shipmentId) {
    const result = await pool.query(
        `
        SELECT
            shipment_id,
            order_id,
            origin,
            destination,
            weight_kg,
            created_at
        FROM shipments
        WHERE shipment_id = $1
        `,
        [shipmentId]
    );

    if (result.rowCount === 0) {
        return apiResponse(404, {
            message: "Shipment not found"
        });
    }

    return apiResponse(
        200,
        shipmentResponse(result.rows[0])
    );
}

async function createShipment(pool, body) {
    requireFields(body, [
        "shipment_id",
        "order_id",
        "origin",
        "destination",
        "weight_kg"
    ]);

    const result = await pool.query(
        `
        INSERT INTO shipments (
            shipment_id,
            order_id,
            origin,
            destination,
            weight_kg,
            created_at
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP))
        RETURNING
            shipment_id,
            order_id,
            origin,
            destination,
            weight_kg,
            created_at
        `,
        [
            String(body.shipment_id),
            String(body.order_id),
            String(body.origin),
            String(body.destination),
            Number(body.weight_kg),
            body.created_at || null
        ]
    );

    return apiResponse(
        201,
        shipmentResponse(result.rows[0])
    );
}

async function updateShipment(pool, shipmentId, body) {
    const allowed = [
        "order_id",
        "origin",
        "destination",
        "weight_kg"
    ];

    const fields = allowed.filter(
        (field) => body[field] !== undefined
    );

    if (fields.length === 0) {
        return apiResponse(400, {
            message: "No shipment fields supplied"
        });
    }

    const values = [];
    const sets = fields.map((field, index) => {
        let value = body[field];

        if (field === "weight_kg") {
            value = Number(value);
        }

        values.push(value);

        return `${field} = $${index + 1}`;
    });

    values.push(shipmentId);

    const result = await pool.query(
        `
        UPDATE shipments
        SET ${sets.join(", ")}
        WHERE shipment_id = $${values.length}
        RETURNING
            shipment_id,
            order_id,
            origin,
            destination,
            weight_kg,
            created_at
        `,
        values
    );

    if (result.rowCount === 0) {
        return apiResponse(404, {
            message: "Shipment not found"
        });
    }

    return apiResponse(
        200,
        shipmentResponse(result.rows[0])
    );
}

async function deleteShipment(pool, shipmentId) {
    const result = await pool.query(
        `
        DELETE FROM shipments
        WHERE shipment_id = $1
        RETURNING shipment_id
        `,
        [shipmentId]
    );

    if (result.rowCount === 0) {
        return apiResponse(404, {
            message: "Shipment not found"
        });
    }

    return apiResponse(200, {
        shipment_id: result.rows[0].shipment_id,
        message: "Shipment deleted successfully"
    });
}

async function getCarrier(pool, carrierId) {
    const result = await pool.query(
        `
        SELECT
            carrier_id,
            name,
            email,
            phone,
            is_active
        FROM carriers
        WHERE carrier_id = $1
        `,
        [carrierId]
    );

    if (result.rowCount === 0) {
        return apiResponse(404, {
            message: "Carrier not found"
        });
    }

    return apiResponse(
        200,
        carrierResponse(result.rows[0])
    );
}

async function createCarrier(pool, body) {
    requireFields(body, [
        "carrier_id",
        "name",
        "email",
        "phone",
        "is_active"
    ]);

    const result = await pool.query(
        `
        INSERT INTO carriers (
            carrier_id,
            name,
            email,
            phone,
            is_active
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            carrier_id,
            name,
            email,
            phone,
            is_active
        `,
        [
            String(body.carrier_id),
            String(body.name),
            String(body.email),
            String(body.phone),
            Boolean(body.is_active)
        ]
    );

    return apiResponse(
        201,
        carrierResponse(result.rows[0])
    );
}

async function updateCarrier(pool, carrierId, body) {
    const allowed = [
        "name",
        "email",
        "phone",
        "is_active"
    ];

    const fields = allowed.filter(
        (field) => body[field] !== undefined
    );

    if (fields.length === 0) {
        return apiResponse(400, {
            message: "No carrier fields supplied"
        });
    }

    const values = [];
    const sets = fields.map((field, index) => {
        let value = body[field];

        if (field === "is_active") {
            value = Boolean(value);
        }

        values.push(value);

        return `${field} = $${index + 1}`;
    });

    values.push(carrierId);

    const result = await pool.query(
        `
        UPDATE carriers
        SET ${sets.join(", ")}
        WHERE carrier_id = $${values.length}
        RETURNING
            carrier_id,
            name,
            email,
            phone,
            is_active
        `,
        values
    );

    if (result.rowCount === 0) {
        return apiResponse(404, {
            message: "Carrier not found"
        });
    }

    return apiResponse(
        200,
        carrierResponse(result.rows[0])
    );
}

async function deleteCarrier(pool, carrierId) {
    const result = await pool.query(
        `
        DELETE FROM carriers
        WHERE carrier_id = $1
        RETURNING carrier_id
        `,
        [carrierId]
    );

    if (result.rowCount === 0) {
        return apiResponse(404, {
            message: "Carrier not found"
        });
    }

    return apiResponse(200, {
        carrier_id: result.rows[0].carrier_id,
        message: "Carrier deleted successfully"
    });
}

async function getStatusUpdates(pool, shipmentId) {
    const result = await pool.query(
        `
        SELECT
            update_id,
            shipment_id,
            carrier_id,
            status,
            location,
            notes,
            "timestamp" AS timestamp
        FROM status_updates
        WHERE shipment_id = $1
        ORDER BY "timestamp" ASC, update_id ASC
        `,
        [shipmentId]
    );

    return apiResponse(
        200,
        result.rows.map(statusResponse)
    );
}

async function createStatusUpdate(pool, body) {
    requireFields(body, [
        "shipment_id",
        "carrier_id",
        "status",
        "location"
    ]);

    const allowedStatuses = new Set([
        "CREATED",
        "IN_TRANSIT",
        "DELAYED",
        "DELIVERED",
        "CANCELLED"
    ]);

    const status = String(body.status).toUpperCase();

    if (!allowedStatuses.has(status)) {
        return apiResponse(400, {
            message: "Invalid status value"
        });
    }

    const result = await pool.query(
        `
        INSERT INTO status_updates (
            shipment_id,
            carrier_id,
            status,
            location,
            notes,
            "timestamp"
        )
        VALUES (
            $1,
            $2,
            $3::"StatusType",
            $4,
            $5,
            COALESCE($6, CURRENT_TIMESTAMP)
        )
        RETURNING
            update_id,
            shipment_id,
            carrier_id,
            status,
            location,
            notes,
            "timestamp" AS timestamp
        `,
        [
            String(body.shipment_id),
            String(body.carrier_id),
            status,
            String(body.location),
            body.notes === undefined
                ? null
                : String(body.notes),
            body.timestamp || null
        ]
    );

    return apiResponse(
        201,
        statusResponse(result.rows[0])
    );
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    console.log("API event:", JSON.stringify(event));

    try {
        const pool = await getPool();

        const method =
            event.httpMethod ||
            event.requestContext?.http?.method ||
            "";

        const resource =
            event.resource ||
            event.rawPath ||
            event.path ||
            "";

        const pathParameters =
            event.pathParameters || {};

        const body = parseBody(event);

        const route = `${method.toUpperCase()} ${resource}`;

        switch (route) {
            case "POST /initdb":
                return await initializeDatabase(pool);

            case "GET /shipments/{shipmentId}":
                return await getShipment(
                    pool,
                    pathParameters.shipmentId
                );

            case "POST /shipments":
                return await createShipment(
                    pool,
                    body
                );

            case "PATCH /shipments/{shipmentId}":
                return await updateShipment(
                    pool,
                    pathParameters.shipmentId,
                    body
                );

            case "DELETE /shipments/{shipmentId}":
                return await deleteShipment(
                    pool,
                    pathParameters.shipmentId
                );

            case "GET /carriers/{carrierId}":
                return await getCarrier(
                    pool,
                    pathParameters.carrierId
                );

            case "POST /carriers":
                return await createCarrier(
                    pool,
                    body
                );

            case "PATCH /carriers/{carrierId}":
                return await updateCarrier(
                    pool,
                    pathParameters.carrierId,
                    body
                );

            case "DELETE /carriers/{carrierId}":
                return await deleteCarrier(
                    pool,
                    pathParameters.carrierId
                );

            case "GET /statusupdates/{shipmentId}":
                return await getStatusUpdates(
                    pool,
                    pathParameters.shipmentId
                );

            case "POST /statusupdates":
                return await createStatusUpdate(
                    pool,
                    body
                );

            default:
                return apiResponse(404, {
                    message: `Unsupported route: ${route}`
                });
        }
    }
    catch (error) {
        console.error("API handler error:", error);

        const statusCode =
            error.statusCode ||
            (
                error.code === "23505"
                    ? 409
                    : error.code === "23503"
                        ? 400
                        : 500
            );

        return apiResponse(statusCode, {
            message:
                statusCode === 500
                    ? "Internal server error"
                    : error.message
        });
    }
};