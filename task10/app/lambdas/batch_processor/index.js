"use strict";

const { Pool } = require("pg");

const {
    SecretsManagerClient,
    GetSecretValueCommand
} = require("@aws-sdk/client-secrets-manager");

const {
    S3Client,
    GetObjectCommand
} = require("@aws-sdk/client-s3");

const {
    parse
} = require("csv-parse/sync");

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

const s3Client = new S3Client({
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

function chunk(items, size) {
    const chunks = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(
            items.slice(index, index + size)
        );
    }

    return chunks;
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

function buildValues(rows, columns) {
    const values = [];

    const placeholders = rows.map((row, rowIndex) => {
        const rowPlaceholders = columns.map(
            (column, columnIndex) => {
                values.push(row[column]);

                return (
                    "$" +
                    (
                        rowIndex * columns.length +
                        columnIndex +
                        1
                    )
                );
            }
        );

        return `(${rowPlaceholders.join(", ")})`;
    });

    return {
        values,
        placeholders: placeholders.join(", ")
    };
}

async function loadShipments(client, records) {
    const normalized = records.map((row) => ({
        shipment_id: String(row.shipment_id),
        order_id: String(row.order_id),
        origin: String(row.origin),
        destination: String(row.destination),
        weight_kg: Number(row.weight_kg),
        created_at:
            row.created_at ||
            new Date().toISOString()
    }));

    const columns = [
        "shipment_id",
        "order_id",
        "origin",
        "destination",
        "weight_kg",
        "created_at"
    ];

    for (const rows of chunk(normalized, 1000)) {
        const batch = buildValues(rows, columns);

        await client.query(
            `
            INSERT INTO shipments (
                shipment_id,
                order_id,
                origin,
                destination,
                weight_kg,
                created_at
            )
            VALUES ${batch.placeholders}
            ON CONFLICT (shipment_id)
            DO UPDATE SET
                order_id = EXCLUDED.order_id,
                origin = EXCLUDED.origin,
                destination = EXCLUDED.destination,
                weight_kg = EXCLUDED.weight_kg,
                created_at = EXCLUDED.created_at
            `,
            batch.values
        );
    }
}

async function loadCarriers(client, records) {
    const normalized = records.map((row) => ({
        carrier_id: String(row.carrier_id),
        name: String(row.name),
        email: String(row.email),
        phone: String(row.phone),
        is_active: parseBoolean(row.is_active)
    }));

    const columns = [
        "carrier_id",
        "name",
        "email",
        "phone",
        "is_active"
    ];

    for (const rows of chunk(normalized, 1000)) {
        const batch = buildValues(rows, columns);

        await client.query(
            `
            INSERT INTO carriers (
                carrier_id,
                name,
                email,
                phone,
                is_active
            )
            VALUES ${batch.placeholders}
            ON CONFLICT (carrier_id)
            DO UPDATE SET
                name = EXCLUDED.name,
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                is_active = EXCLUDED.is_active
            `,
            batch.values
        );
    }
}

async function loadStatusUpdates(client, records) {
    const allowedStatuses = new Set([
        "CREATED",
        "IN_TRANSIT",
        "DELAYED",
        "DELIVERED",
        "CANCELLED"
    ]);

    const normalized = records.map((row) => {
        const status = String(row.status).toUpperCase();

        if (!allowedStatuses.has(status)) {
            throw new Error(
                `Invalid shipment status: ${status}`
            );
        }

        return {
            shipment_id: String(row.shipment_id),
            carrier_id: String(row.carrier_id),
            status,
            location: String(row.location),
            notes:
                row.notes === undefined
                    ? null
                    : String(row.notes),
            timestamp:
                row.timestamp ||
                new Date().toISOString()
        };
    });

    const columns = [
        "shipment_id",
        "carrier_id",
        "status",
        "location",
        "notes",
        "timestamp"
    ];

    for (const rows of chunk(normalized, 1000)) {
        const values = [];

        const placeholders = rows.map((row, rowIndex) => {
            const offset = rowIndex * columns.length;

            values.push(
                row.shipment_id,
                row.carrier_id,
                row.status,
                row.location,
                row.notes,
                row.timestamp
            );

            return `(
                $${offset + 1},
                $${offset + 2},
                $${offset + 3}::"StatusType",
                $${offset + 4},
                $${offset + 5},
                $${offset + 6}
            )`;
        });

        await client.query(
            `
            INSERT INTO status_updates (
                shipment_id,
                carrier_id,
                status,
                location,
                notes,
                "timestamp"
            )
            VALUES ${placeholders.join(", ")}
            `,
            values
        );
    }
}

async function processObject(bucket, key) {
    const objectResponse = await s3Client.send(
        new GetObjectCommand({
            Bucket: bucket,
            Key: key
        })
    );

    const csvText =
        await objectResponse.Body.transformToString();

    const records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true
    });

    const fileName = key
        .split("/")
        .pop()
        .toLowerCase();

    const pool = await getPool();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        await client.query(SCHEMA_SQL);

        if (fileName === "shipments.csv") {
            await loadShipments(client, records);
        }
        else if (fileName === "carriers.csv") {
            await loadCarriers(client, records);
        }
        else if (fileName === "status_updates.csv") {
            await loadStatusUpdates(client, records);
        }
        else {
            console.log(
                `Ignoring unsupported file: ${fileName}`
            );

            await client.query("ROLLBACK");

            return {
                file: fileName,
                ignored: true,
                processed: 0
            };
        }

        await client.query("COMMIT");

        return {
            file: fileName,
            ignored: false,
            processed: records.length
        };
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    console.log(
        "S3 event:",
        JSON.stringify(event)
    );

    const results = [];

    for (const record of event.Records || []) {
        const bucket = record.s3.bucket.name;

        const key = decodeURIComponent(
            record.s3.object.key.replace(/\+/g, " ")
        );

        const startedAt = Date.now();

        const result = await processObject(
            bucket,
            key
        );

        result.duration_ms =
            Date.now() - startedAt;

        results.push(result);

        console.log(
            "ETL result:",
            JSON.stringify(result)
        );
    }

    return {
        statusCode: 200,
        results
    };
};