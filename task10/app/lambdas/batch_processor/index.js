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
    region: REGION,
    maxAttempts: 4
});

const s3Client = new S3Client({
    region: REGION,
    maxAttempts: 4
});

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

const VALID_STATUSES = new Set([
    "CREATED",
    "IN_TRANSIT",
    "DELAYED",
    "DELIVERED",
    "CANCELLED"
]);

let poolPromise;

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
    `,

    `
    CREATE TABLE IF NOT EXISTS etl_imports (
        bucket_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        object_etag TEXT NOT NULL,
        file_type VARCHAR(30) NOT NULL,
        processed_rows INTEGER NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (
            bucket_name,
            object_key,
            object_etag
        )
    );
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

    if (RETRYABLE_ERROR_CODES.has(error.code)) {
        return true;
    }

    const message = String(error.message || "")
        .toLowerCase();

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

            await sleep(
                Math.min(attempt * 500, 2000)
            );
        }
    }

    throw lastError;
}

async function getDatabaseSecret() {
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

    const secret = JSON.parse(
        response.SecretString
    );

    if (!secret.username || !secret.password) {
        throw new Error(
            "The RDS secret does not contain username/password"
        );
    }

    return secret;
}

function createDatabasePool(
    secret,
    databaseName
) {
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

        max: 3,
        min: 0,

        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 5000,
        statement_timeout: 45000,
        query_timeout: 45000,

        keepAlive: true,
        allowExitOnIdle: true
    });
}

function quoteIdentifier(identifier) {
    if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(
            identifier
        )
    ) {
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
    const secret = await getDatabaseSecret();

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
        poolPromise = createPool().catch(
            (error) => {
                poolPromise = undefined;
                throw error;
            }
        );
    }

    return poolPromise;
}

async function ensureSchema(client) {
    await client.query(
        "SELECT pg_advisory_lock($1)",
        [920260710]
    );

    try {
        for (
            const statement of SCHEMA_STATEMENTS
        ) {
            await client.query(statement);
        }
    }
    finally {
        await client.query(
            "SELECT pg_advisory_unlock($1)",
            [920260710]
        );
    }
}

async function bodyToString(body) {
    if (!body) {
        throw new Error(
            "S3 GetObject returned an empty body"
        );
    }

    if (
        typeof body.transformToString ===
        "function"
    ) {
        return body.transformToString();
    }

    const chunks = [];

    for await (const chunk of body) {
        chunks.push(
            Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk)
        );
    }

    return Buffer.concat(chunks)
        .toString("utf8");
}

async function readCsvFromS3(
    bucket,
    key
) {
    const response = await withRetry(
        `S3 GetObject ${bucket}/${key}`,
        () => s3Client.send(
            new GetObjectCommand({
                Bucket: bucket,
                Key: key
            })
        ),
        4
    );

    const csvText = await bodyToString(
        response.Body
    );

    if (!csvText.trim()) {
        throw new Error(
            `CSV file is empty: ${key}`
        );
    }

    return csvText;
}

function normalizeHeader(header) {
    return String(header)
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase();
}

function parseCsv(csvText) {
    const records = parse(csvText, {
        bom: true,
        columns: (headers) => {
            return headers.map(
                normalizeHeader
            );
        },
        skip_empty_lines: true,
        trim: true,
        relax_quotes: true,
        relax_column_count: true
    });

    return records.filter((record) => {
        return Object.values(record).some(
            (value) => {
                return (
                    value !== undefined &&
                    value !== null &&
                    String(value).trim() !== ""
                );
            }
        );
    });
}

function detectFileType(key) {
    const fileName = decodeURIComponent(key)
        .replace(/\+/g, " ")
        .split("/")
        .pop()
        .toLowerCase()
        .replace(/-/g, "_");

    if (
        fileName.includes("status_updates") ||
        fileName.includes("statusupdates")
    ) {
        return "status_updates";
    }

    if (fileName.includes("shipments")) {
        return "shipments";
    }

    if (fileName.includes("carriers")) {
        return "carriers";
    }

    return null;
}

function splitIntoChunks(
    items,
    chunkSize
) {
    const chunks = [];

    for (
        let index = 0;
        index < items.length;
        index += chunkSize
    ) {
        chunks.push(
            items.slice(
                index,
                index + chunkSize
            )
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

function requireValue(
    record,
    fieldName,
    rowNumber
) {
    const value = record[fieldName];

    if (
        value === undefined ||
        value === null ||
        String(value).trim() === ""
    ) {
        throw new Error(
            `Missing ${fieldName} at CSV row ${rowNumber}`
        );
    }

    return value;
}

function buildValues(
    records,
    columns
) {
    const values = [];

    const placeholders = records.map(
        (record, recordIndex) => {
            const rowPlaceholders =
                columns.map(
                    (column, columnIndex) => {
                        values.push(
                            record[column]
                        );

                        return (
                            "$" +
                            (
                                recordIndex *
                                    columns.length +
                                columnIndex +
                                1
                            )
                        );
                    }
                );

            return (
                "(" +
                rowPlaceholders.join(", ") +
                ")"
            );
        }
    );

    return {
        values,
        placeholders: placeholders.join(", ")
    };
}

function normalizeShipments(records) {
    return records.map(
        (record, index) => {
            const weight = Number(
                requireValue(
                    record,
                    "weight_kg",
                    index + 2
                )
            );

            if (!Number.isFinite(weight)) {
                throw new Error(
                    `Invalid weight_kg at CSV row ${index + 2}`
                );
            }

            return {
                shipment_id: String(
                    requireValue(
                        record,
                        "shipment_id",
                        index + 2
                    )
                ),

                order_id: String(
                    requireValue(
                        record,
                        "order_id",
                        index + 2
                    )
                ),

                origin: String(
                    requireValue(
                        record,
                        "origin",
                        index + 2
                    )
                ),

                destination: String(
                    requireValue(
                        record,
                        "destination",
                        index + 2
                    )
                ),

                weight_kg: weight,

                created_at:
                    record.created_at ||
                    new Date().toISOString()
            };
        }
    );
}

function normalizeCarriers(records) {
    return records.map(
        (record, index) => {
            return {
                carrier_id: String(
                    requireValue(
                        record,
                        "carrier_id",
                        index + 2
                    )
                ),

                name: String(
                    requireValue(
                        record,
                        "name",
                        index + 2
                    )
                ),

                email: String(
                    requireValue(
                        record,
                        "email",
                        index + 2
                    )
                ),

                phone: String(
                    requireValue(
                        record,
                        "phone",
                        index + 2
                    )
                ),

                is_active: parseBoolean(
                    requireValue(
                        record,
                        "is_active",
                        index + 2
                    )
                )
            };
        }
    );
}

function normalizeStatusUpdates(records) {
    return records.map(
        (record, index) => {
            const status = String(
                requireValue(
                    record,
                    "status",
                    index + 2
                )
            )
                .trim()
                .toUpperCase();

            if (!VALID_STATUSES.has(status)) {
                throw new Error(
                    `Invalid status '${status}' at CSV row ${index + 2}`
                );
            }

            return {
                shipment_id: String(
                    requireValue(
                        record,
                        "shipment_id",
                        index + 2
                    )
                ),

                carrier_id: String(
                    requireValue(
                        record,
                        "carrier_id",
                        index + 2
                    )
                ),

                status,

                location: String(
                    requireValue(
                        record,
                        "location",
                        index + 2
                    )
                ),

                notes:
                    record.notes === undefined ||
                    record.notes === null
                        ? null
                        : String(record.notes),

                timestamp:
                    record.timestamp ||
                    new Date().toISOString()
            };
        }
    );
}

async function loadShipments(
    client,
    records
) {
    const normalized =
        normalizeShipments(records);

    const columns = [
        "shipment_id",
        "order_id",
        "origin",
        "destination",
        "weight_kg",
        "created_at"
    ];

    for (
        const batch of splitIntoChunks(
            normalized,
            1000
        )
    ) {
        const values = buildValues(
            batch,
            columns
        );

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
            VALUES ${values.placeholders}
            ON CONFLICT (shipment_id)
            DO UPDATE SET
                order_id = EXCLUDED.order_id,
                origin = EXCLUDED.origin,
                destination = EXCLUDED.destination,
                weight_kg = EXCLUDED.weight_kg,
                created_at = EXCLUDED.created_at
            `,
            values.values
        );
    }

    return normalized.length;
}

async function loadCarriers(
    client,
    records
) {
    const normalized =
        normalizeCarriers(records);

    const columns = [
        "carrier_id",
        "name",
        "email",
        "phone",
        "is_active"
    ];

    for (
        const batch of splitIntoChunks(
            normalized,
            1000
        )
    ) {
        const values = buildValues(
            batch,
            columns
        );

        await client.query(
            `
            INSERT INTO carriers (
                carrier_id,
                name,
                email,
                phone,
                is_active
            )
            VALUES ${values.placeholders}
            ON CONFLICT (carrier_id)
            DO UPDATE SET
                name = EXCLUDED.name,
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                is_active = EXCLUDED.is_active
            `,
            values.values
        );
    }

    return normalized.length;
}

async function insertStatusUpdateBatch(
    client,
    batch
) {
    const values = [];

    const placeholders = batch.map(
        (record, recordIndex) => {
            const offset = recordIndex * 6;

            values.push(
                record.shipment_id,
                record.carrier_id,
                record.status,
                record.location,
                record.notes,
                record.timestamp
            );

            return `
            (
                $${offset + 1},
                $${offset + 2},
                $${offset + 3}::"StatusType",
                $${offset + 4},
                $${offset + 5},
                $${offset + 6}
            )
            `;
        }
    );

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

async function loadStatusUpdates(
    client,
    records
) {
    const normalized =
        normalizeStatusUpdates(records);

    for (
        let attempt = 1;
        attempt <= 12;
        attempt += 1
    ) {
        await client.query(
            "SAVEPOINT status_import"
        );

        try {
            for (
                const batch of splitIntoChunks(
                    normalized,
                    1000
                )
            ) {
                await insertStatusUpdateBatch(
                    client,
                    batch
                );
            }

            await client.query(
                "RELEASE SAVEPOINT status_import"
            );

            return normalized.length;
        }
        catch (error) {
            await client.query(
                "ROLLBACK TO SAVEPOINT status_import"
            );

            if (
                error.code !== "23503" ||
                attempt === 12
            ) {
                throw error;
            }

            console.warn(
                "Shipments or carriers are not ready yet. " +
                `Status import retry ${attempt}/12`
            );

            await sleep(1500);
        }
    }

    throw new Error(
        "Status update import retries exhausted"
    );
}

async function wasAlreadyProcessed(
    client,
    bucket,
    key,
    etag
) {
    const result = await client.query(
        `
        SELECT 1
        FROM etl_imports
        WHERE
            bucket_name = $1 AND
            object_key = $2 AND
            object_etag = $3
        `,
        [
            bucket,
            key,
            etag
        ]
    );

    return result.rowCount > 0;
}

async function markAsProcessed(
    client,
    bucket,
    key,
    etag,
    fileType,
    processedRows
) {
    await client.query(
        `
        INSERT INTO etl_imports (
            bucket_name,
            object_key,
            object_etag,
            file_type,
            processed_rows
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (
            bucket_name,
            object_key,
            object_etag
        )
        DO NOTHING
        `,
        [
            bucket,
            key,
            etag,
            fileType,
            processedRows
        ]
    );
}

async function getTableCount(
    client,
    fileType
) {
    const tableNames = {
        shipments: "shipments",
        carriers: "carriers",
        status_updates: "status_updates"
    };

    const tableName =
        tableNames[fileType];

    const result = await client.query(
        `SELECT COUNT(*)::integer AS count FROM ${tableName}`
    );

    return Number(result.rows[0].count);
}

async function processObject(
    bucket,
    key,
    etag
) {
    const fileType = detectFileType(key);

    if (!fileType) {
        console.log(
            `Ignoring unsupported object: ${key}`
        );

        return {
            bucket,
            key,
            ignored: true,
            processed_rows: 0
        };
    }

    const csvText = await readCsvFromS3(
        bucket,
        key
    );

    const records = parseCsv(csvText);

    console.log(
        "CSV parsed:",
        {
            bucket,
            key,
            fileType,
            rowCount: records.length
        }
    );

    if (records.length === 0) {
        throw new Error(
            `No data rows found in ${key}`
        );
    }

    const pool = await getPool();
    const client = await pool.connect();

    try {
        await ensureSchema(client);
        await client.query("BEGIN");

        const alreadyProcessed =
            await wasAlreadyProcessed(
                client,
                bucket,
                key,
                etag
            );

        if (alreadyProcessed) {
            await client.query("ROLLBACK");

            console.log(
                `Object was already processed: ${key}`
            );

            return {
                bucket,
                key,
                file_type: fileType,
                skipped: true,
                processed_rows: 0
            };
        }

        let processedRows;

        if (fileType === "shipments") {
            processedRows = await loadShipments(
                client,
                records
            );
        }
        else if (fileType === "carriers") {
            processedRows = await loadCarriers(
                client,
                records
            );
        }
        else {
            processedRows =
                await loadStatusUpdates(
                    client,
                    records
                );
        }

        await markAsProcessed(
            client,
            bucket,
            key,
            etag,
            fileType,
            processedRows
        );

        await client.query("COMMIT");

        const tableCount = await getTableCount(
            client,
            fileType
        );

        return {
            bucket,
            key,
            file_type: fileType,
            skipped: false,
            processed_rows: processedRows,
            table_count: tableCount
        };
    }
    catch (error) {
        await client.query("ROLLBACK")
            .catch(() => {});

        throw error;
    }
    finally {
        client.release();
    }
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    console.log(
        "Batch processor event:",
        JSON.stringify(event)
    );

    const startedAt = Date.now();
    const results = [];

    try {
        for (
            const record of event.Records || []
        ) {
            const bucket =
                record.s3.bucket.name;

            const key = decodeURIComponent(
                record.s3.object.key
                    .replace(/\+/g, " ")
            );

            const etag = String(
                record.s3.object.eTag ||
                record.s3.object.etag ||
                record.s3.object.sequencer ||
                "unknown"
            ).replace(/"/g, "");

            const objectStartedAt = Date.now();

            const result = await processObject(
                bucket,
                key,
                etag
            );

            result.duration_ms =
                Date.now() -
                objectStartedAt;

            results.push(result);

            console.log(
                "ETL object completed:",
                JSON.stringify(result)
            );
        }

        const response = {
            statusCode: 200,
            processed_objects: results.length,
            duration_ms:
                Date.now() - startedAt,
            results
        };

        console.log(
            "ETL execution completed:",
            JSON.stringify(response)
        );

        return response;
    }
    catch (error) {
        poolPromise = undefined;

        console.error(
            "ETL execution failed:",
            {
                name: error.name,
                code: error.code,
                message: error.message,
                stack: error.stack,

                configuration: {
                    region: REGION,
                    database: DB_NAME,
                    port: DB_PORT,
                    hasDbEndpoint:
                        Boolean(DB_ENDPOINT),
                    hasSecretName:
                        Boolean(SECRET_NAME)
                }
            }
        );

        throw error;
    }
};