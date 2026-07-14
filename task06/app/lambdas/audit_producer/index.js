"use strict";

const crypto = require("crypto");

function fromAttributeValue(attribute) {
    if (!attribute || typeof attribute !== "object") {
        return undefined;
    }

    if (Object.prototype.hasOwnProperty.call(attribute, "S")) {
        return attribute.S;
    }

    if (Object.prototype.hasOwnProperty.call(attribute, "N")) {
        return Number(attribute.N);
    }

    if (Object.prototype.hasOwnProperty.call(attribute, "BOOL")) {
        return Boolean(attribute.BOOL);
    }

    if (Object.prototype.hasOwnProperty.call(attribute, "NULL")) {
        return null;
    }

    if (Object.prototype.hasOwnProperty.call(attribute, "M")) {
        return unmarshallImage(attribute.M);
    }

    if (Object.prototype.hasOwnProperty.call(attribute, "L")) {
        return attribute.L.map(fromAttributeValue);
    }

    if (Object.prototype.hasOwnProperty.call(attribute, "SS")) {
        return [...attribute.SS];
    }

    if (Object.prototype.hasOwnProperty.call(attribute, "NS")) {
        return attribute.NS.map(Number);
    }

    return undefined;
}

function toAttributeValue(value) {
    if (value === null) {
        return { NULL: true };
    }

    if (typeof value === "string") {
        return { S: value };
    }

    if (typeof value === "number") {
        return { N: String(value) };
    }

    if (typeof value === "boolean") {
        return { BOOL: value };
    }

    if (Array.isArray(value)) {
        return {
            L: value.map(toAttributeValue)
        };
    }

    if (typeof value === "object") {
        return {
            M: Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    key,
                    toAttributeValue(item)
                ])
            )
        };
    }

    throw new TypeError(
        `Unsupported DynamoDB value type: ${typeof value}`
    );
}

function unmarshallImage(image) {
    if (!image || typeof image !== "object") {
        return {};
    }

    return Object.fromEntries(
        Object.entries(image).map(([key, value]) => [
            key,
            fromAttributeValue(value)
        ])
    );
}

function marshalAuditItem(auditEntry) {
    return Object.fromEntries(
        Object.entries(auditEntry)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [
                key,
                toAttributeValue(value)
            ])
    );
}

function areEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function buildAuditEntries(
    record,
    modificationTime = new Date().toISOString(),
    createId = () => crypto.randomUUID()
) {
    const eventName = record && record.eventName;
    const dynamodb = record && record.dynamodb
        ? record.dynamodb
        : {};

    const oldItem = unmarshallImage(dynamodb.OldImage);
    const newItem = unmarshallImage(dynamodb.NewImage);

    const itemKey = newItem.key !== undefined
        ? newItem.key
        : oldItem.key;

    if (typeof itemKey !== "string" || !itemKey) {
        console.warn(
            "Stream record ignored because item key is missing:",
            JSON.stringify(record)
        );

        return [];
    }

    if (eventName === "INSERT") {
        return [
            {
                id: createId(),
                itemKey,
                modificationTime,
                newValue: newItem
            }
        ];
    }

    if (eventName === "MODIFY") {
        const changedAttributes = new Set([
            ...Object.keys(oldItem),
            ...Object.keys(newItem)
        ]);

        changedAttributes.delete("key");

        return [...changedAttributes]
            .filter(
                (attributeName) =>
                    !areEqual(
                        oldItem[attributeName],
                        newItem[attributeName]
                    )
            )
            .map((attributeName) => ({
                id: createId(),
                itemKey,
                modificationTime,
                updatedAttribute: attributeName,
                oldValue: oldItem[attributeName],
                newValue: newItem[attributeName]
            }));
    }

    console.log(
        `DynamoDB event ${eventName} does not require an audit entry.`
    );

    return [];
}

exports.handler = async (event) => {
    console.log(
        "DynamoDB Stream event:",
        JSON.stringify(event)
    );

    const tableName = process.env.target_table;

    if (!tableName) {
        throw new Error(
            "The target_table environment variable is missing."
        );
    }

    const {
        DynamoDBClient,
        PutItemCommand
    } = require("@aws-sdk/client-dynamodb");

    const client = new DynamoDBClient({});
    const records = Array.isArray(event && event.Records)
        ? event.Records
        : [];

    let createdCount = 0;

    for (const record of records) {
        const auditEntries = buildAuditEntries(record);

        for (const auditEntry of auditEntries) {
            console.log(
                "Writing audit entry:",
                JSON.stringify(auditEntry)
            );

            await client.send(
                new PutItemCommand({
                    TableName: tableName,
                    Item: marshalAuditItem(auditEntry)
                })
            );

            createdCount += 1;
        }
    }

    return {
        processedRecords: records.length,
        createdAuditEntries: createdCount
    };
};

exports.buildAuditEntries = buildAuditEntries;
exports.unmarshallImage = unmarshallImage;
exports.marshalAuditItem = marshalAuditItem;