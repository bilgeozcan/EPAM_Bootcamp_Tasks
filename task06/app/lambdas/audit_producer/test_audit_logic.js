"use strict";

const assert = require("assert");
const {
    buildAuditEntries,
    marshalAuditItem
} = require("./index");

const timestamp = "2024-01-01T00:00:00.000Z";

const insertRecord = {
    eventName: "INSERT",
    dynamodb: {
        NewImage: {
            key: {
                S: "CACHE_TTL_SEC"
            },
            value: {
                N: "3600"
            }
        }
    }
};

const insertAuditEntries = buildAuditEntries(
    insertRecord,
    timestamp,
    () => "insert-uuid"
);

assert.strictEqual(insertAuditEntries.length, 1);

assert.deepStrictEqual(
    insertAuditEntries[0],
    {
        id: "insert-uuid",
        itemKey: "CACHE_TTL_SEC",
        modificationTime: timestamp,
        newValue: {
            key: "CACHE_TTL_SEC",
            value: 3600
        }
    }
);

const modifyRecord = {
    eventName: "MODIFY",
    dynamodb: {
        OldImage: {
            key: {
                S: "CACHE_TTL_SEC"
            },
            value: {
                N: "3600"
            }
        },
        NewImage: {
            key: {
                S: "CACHE_TTL_SEC"
            },
            value: {
                N: "1800"
            }
        }
    }
};

const modifyAuditEntries = buildAuditEntries(
    modifyRecord,
    timestamp,
    () => "modify-uuid"
);

assert.strictEqual(modifyAuditEntries.length, 1);

assert.deepStrictEqual(
    modifyAuditEntries[0],
    {
        id: "modify-uuid",
        itemKey: "CACHE_TTL_SEC",
        modificationTime: timestamp,
        updatedAttribute: "value",
        oldValue: 3600,
        newValue: 1800
    }
);

const marshalledInsert =
    marshalAuditItem(insertAuditEntries[0]);

assert.strictEqual(
    marshalledInsert.newValue.M.value.N,
    "3600"
);

const marshalledModify =
    marshalAuditItem(modifyAuditEntries[0]);

assert.strictEqual(
    marshalledModify.oldValue.N,
    "3600"
);

assert.strictEqual(
    marshalledModify.newValue.N,
    "1800"
);

console.log("INSERT audit model: PASSED");
console.log("MODIFY audit model: PASSED");
console.log("DynamoDB marshalling: PASSED");