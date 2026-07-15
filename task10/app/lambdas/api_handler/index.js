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
    region: REGION,
    maxAttempts: 4
});

let poolPromise;

const RETRYABLE_ERROR_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "57P03",
    "53300",
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "08P01"
]);

const NON_RETRYABLE_ERROR_CODES = new Set([
    "28P01",
    "3D000",
    "42501",
    "42601"
]);

const SCHEMA_STATEMENTS = [
    `
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1
            FROM pg_type
            WHERE typname = 'StatusType'
        ) THEN
            CREATE TYPE "StatusType" AS ENUM (
                'CREATED',
                'IN_TRANSIT',
                'DELAYED',
                'DELIVERED',
                'CANCELLED'
            );
        END IF;
    END
    $$;
    `,

    `
    CREATE TABLE IF NOT EXISTS shipments (
        shipment_id VARCHAR(50) PRIMARY KEY,
        order_id VARCHAR(50) NOT NULL,
        origin VARCHAR(100) NOT NULL,
        destination VARCHAR(100) NOT NULL,
        weight_kg NUMERIC(10, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
            DEFAULT CURRENT_TIMESTAMP
    );
    `,

    `
    CREATE TABLE IF NOT EXISTS carriers (
        carrier_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        is_active BOOLEAN NOT NULL
    );
    `,

    `
    CREATE TABLE IF NOT EXISTS status_updates (
        update_id SERIAL PRIMARY KEY,
        shipment_id VARCHAR(50) NOT NULL,
        carrier_id VARCHAR(50) NOT NULL,
        status "StatusType" NOT NULL,
        location VARCHAR(100) NOT NULL,
        notes TEXT,
        "timestamp" TIMESTAMPTZ NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT fk_status_shipment
            FOREIGN KEY (shipment_id)
            REFERENCES shipments(shipment_id)
            ON DELETE CASCADE,

        CONSTRAINT fk_status_carrier
            FOREIGN KEY (carrier_id)
            REFERENCES carriers(carrier_id)
            ON DELETE CASCADE
    );
    `,

    `
    CREATE INDEX IF NOT EXISTS idx_status_updates_shipment
        ON status_updates(shipment_id);
    `,

    `
    CREATE INDEX IF NOT EXISTS idx_status_updates_carrier
        ON status_updates(carrier_id);
    `
];

function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function isRetryable(error) {
    if (!error) {
        return true;
    }

    if (NON_RETRYABLE_ERROR_CODES.has(error.code)) {
        return false;
    }

    if (RETRYABLE_ERROR_CODES.has(error.code)) {
        return true;
    }

    const message = String(error.message || "").toLowerCase();

    return (
        message.includes("timeout") ||
        message.includes("temporarily unavailable") ||
        message.includes("connection terminated") ||
        message.includes("connection refused") ||
        message.includes("socket hang up")
    );
}

async function withRetry(
    operationName,
    operation,
    maximumAttempts = 5
) {
    let lastError;

    for (
        let attempt = 1;
        attempt <= maximumAttempts;
        attempt += 1
    ) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;

            console.error(
                `${operationName} failed on attempt ` +
                `${attempt}/${maximumAttempts}:`,
                {
                    name: error.name,
                    code: error.code,
                    message: error.message
                }
            );

            if (
                attempt === maximumAttempts ||
                !isRetryable(error)
            ) {
                throw error;
            }

            const delayMilliseconds = Math.min(
                attempt * 500,
                2000
            );

            await sleep(delayMilliseconds);
        }
    }

    throw lastError;
}

function apiResponse(statusCode, payload) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        isBase64Encoded: false
    };
}

function parseBody(event) {
    if (
        !event ||
        event.body === undefined ||
        event.body === null ||
        event.body === ""
    ) {
        return {};
    }

    if (typeof event.body === "object") {
        return event.body;
    }

    return JSON.parse(event.body);
}

function parseBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }

    const normalized = String(value)
        .trim()
        .toLowerCase();

    return [
        "true",
        "1",
        "yes",
        "y"
    ].includes(normalized);
}

function requireFields(body, fields) {
    const missingFields = fields.filter((field) => {
        return (
            body[field] === undefined ||
            body[field] === null ||
            body[field] === ""
        );
    });

    if (missingFields.length > 0) {
        const error = new Error(
            `Missing required fields: ${missingFields.join(", ")}`
        );

        error.statusCode = 400;
        throw error;
    }
}

async function loadDatabaseSecret() {
    if (!SECRET_NAME) {
        throw new Error(
            "MASTER_USER_SECRET_NAME environment variable is missing"
        );
    }

    const response = await withRetry(
        "Secrets Manager GetSecretValue",
        () => secretsClient.send(
            new GetSecretValueCommand({
                SecretId: SECRET_NAME
            })
        ),
        4
    );

    if (!response.SecretString) {
        throw new Error(
            "The RDS master secret has no SecretString"
        );
    }

    const secret = JSON.parse(response.SecretString);

    if (!secret.username || !secret.password) {
        throw new Error(
            "The RDS secret does not contain username/password"
        );
    }

    return secret;
}

function createDatabasePool(secret, databaseName) {
    const host =
        secret.host ||
        DB_ENDPOINT;

    const port = Number(
        secret.port ||
        DB_PORT
    );

    if (!host) {
        throw new Error(
            "Neither DB_ENDPOINT nor secret.host is available"
        );
    }

    return new Pool({
        host,
        port,
        database: databaseName,
        user: secret.username,
        password: secret.password,

        ssl: {
            rejectUnauthorized: false
        },

        max: 4,
        min: 0,

        connectionTimeoutMillis: 2500,
        idleTimeoutMillis: 5000,
        statement_timeout: 20000,
        query_timeout: 20000,

        keepAlive: true,
        allowExitOnIdle: true
    });
}

function quoteIdentifier(identifier) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(
            `Invalid PostgreSQL identifier: ${identifier}`
        );
    }

    return `"${identifier.replace(/"/g, "\"\"")}"`;
}

async function ensureTargetDatabase(secret) {
    const adminPool = createDatabasePool(
        secret,
        "postgres"
    );

    try {
        await withRetry(
            "Aurora admin connection",
            () => adminPool.query("SELECT 1"),
            5
        );

        try {
            await adminPool.query(
                `CREATE DATABASE ${quoteIdentifier(DB_NAME)}`
            );

            console.log(
                `Database ${DB_NAME} was created`
            );
        }
        catch (error) {
            if (error.code !== "42P04") {
                throw error;
            }

            console.log(
                `Database ${DB_NAME} already exists`
            );
        }
    }
    finally {
        await adminPool.end().catch(() => {});
    }
}

async function createPool() {
    const secret = await loadDatabaseSecret();

    let pool = createDatabasePool(
        secret,
        DB_NAME
    );

    try {
        await withRetry(
            "Aurora database connection",
            () => pool.query("SELECT 1"),
            5
        );

        return pool;
    }
    catch (error) {
        await pool.end().catch(() => {});

        if (error.code !== "3D000") {
            throw error;
        }

        console.warn(
            `Database ${DB_NAME} does not exist; creating it`
        );

        await ensureTargetDatabase(secret);

        pool = createDatabasePool(
            secret,
            DB_NAME
        );

        await withRetry(
            "Aurora connection after database creation",
            () => pool.query("SELECT 1"),
            5
        );

        return pool;
    }
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

async function initializeDatabase(pool) {
    const client = await withRetry(
        "Acquire PostgreSQL client",
        () => pool.connect(),
        5
    );

    try {
        await client.query("BEGIN");

        for (const statement of SCHEMA_STATEMENTS) {
            await client.query(statement);
        }

        await client.query("COMMIT");

        const verification = await client.query(`
            SELECT
                to_regclass('public.shipments') AS shipments,
                to_regclass('public.carriers') AS carriers,
                to_regclass('public.status_updates') AS status_updates
        `);

        const tables = verification.rows[0];

        if (
            !tables.shipments ||
            !tables.carriers ||
            !tables.status_updates
        ) {
            throw new Error(
                "Database schema verification failed"
            );
        }

        return apiResponse(200, {
            message: "Initialization is successful"
        });
    }
    catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    }
    finally {
        client.release();
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
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            COALESCE($6, CURRENT_TIMESTAMP)
        )
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

async function updateShipment(
    pool,
    shipmentId,
    body
) {
    const allowedFields = [
        "order_id",
        "origin",
        "destination",
        "weight_kg"
    ];

    const suppliedFields = allowedFields.filter(
        (field) => body[field] !== undefined
    );

    if (suppliedFields.length === 0) {
        return apiResponse(400, {
            message: "No shipment fields supplied"
        });
    }

    const values = [];

    const assignments = suppliedFields.map(
        (field, index) => {
            let value = body[field];

            if (field === "weight_kg") {
                value = Number(value);
            }

            values.push(value);

            return `${field} = $${index + 1}`;
        }
    );

    values.push(shipmentId);

    const result = await pool.query(
        `
        UPDATE shipments
        SET ${assignments.join(", ")}
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

async function deleteShipment(
    pool,
    shipmentId
) {
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
            parseBoolean(body.is_active)
        ]
    );

    return apiResponse(
        201,
        carrierResponse(result.rows[0])
    );
}

async function updateCarrier(
    pool,
    carrierId,
    body
) {
    const allowedFields = [
        "name",
        "email",
        "phone",
        "is_active"
    ];

    const suppliedFields = allowedFields.filter(
        (field) => body[field] !== undefined
    );

    if (suppliedFields.length === 0) {
        return apiResponse(400, {
            message: "No carrier fields supplied"
        });
    }

    const values = [];

    const assignments = suppliedFields.map(
        (field, index) => {
            let value = body[field];

            if (field === "is_active") {
                value = parseBoolean(value);
            }

            values.push(value);

            return `${field} = $${index + 1}`;
        }
    );

    values.push(carrierId);

    const result = await pool.query(
        `
        UPDATE carriers
        SET ${assignments.join(", ")}
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

async function deleteCarrier(
    pool,
    carrierId
) {
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

async function getStatusUpdates(
    pool,
    shipmentId
) {
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

async function createStatusUpdate(
    pool,
    body
) {
    requireFields(body, [
        "shipment_id",
        "carrier_id",
        "status",
        "location"
    ]);

    const validStatuses = new Set([
        "CREATED",
        "IN_TRANSIT",
        "DELAYED",
        "DELIVERED",
        "CANCELLED"
    ]);

    const status = String(body.status)
        .trim()
        .toUpperCase();

    if (!validStatuses.has(status)) {
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

    console.log(
        "API request:",
        JSON.stringify({
            resource: event?.resource,
            path: event?.path,
            rawPath: event?.rawPath,
            method:
                event?.httpMethod ||
                event?.requestContext?.http?.method
        })
    );

    try {
        const method = String(
            event?.httpMethod ||
            event?.requestContext?.http?.method ||
            ""
        ).toUpperCase();

        const resource =
            event?.resource ||
            event?.rawPath ||
            event?.path ||
            "";

        const pathParameters =
            event?.pathParameters ||
            {};

        const body = parseBody(event);

        const route = `${method} ${resource}`;

        const pool = await getPool();

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
        poolPromise = undefined;

        console.error(
            "API handler failed:",
            {
                name: error.name,
                code: error.code,
                message: error.message,
                stack: error.stack,

                configuration: {
                    region: REGION,
                    database: DB_NAME,
                    port: DB_PORT,
                    hasDbEndpoint: Boolean(DB_ENDPOINT),
                    hasSecretName: Boolean(SECRET_NAME)
                }
            }
        );

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
                    : error.message,

            errorCode:
                error.code ||
                error.name ||
                "UNKNOWN_ERROR"
        });
    }
};