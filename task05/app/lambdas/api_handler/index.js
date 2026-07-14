"use strict";

const crypto = require("crypto");
const {
    DynamoDBClient,
    PutItemCommand
} = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({});
const tableName = process.env.target_table;

function createResponse(statusCode, payload) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    };
}

function parseRequest(event) {
    if (!event) {
        return {};
    }

    if (typeof event.body === "string") {
        const decodedBody = event.isBase64Encoded
            ? Buffer.from(event.body, "base64").toString("utf8")
            : event.body;

        return decodedBody ? JSON.parse(decodedBody) : {};
    }

    if (event.body && typeof event.body === "object") {
        return event.body;
    }

    return event;
}

function marshalStringMap(value) {
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            key,
            {
                S: String(item)
            }
        ])
    );
}

exports.handler = async (event) => {
    console.log("Incoming event:", JSON.stringify(event));

    try {
        if (!tableName) {
            throw new Error("The target_table environment variable is missing.");
        }

        const request = parseRequest(event);
        const principalId = request.principalId;
        const content = request.content;

        if (!Number.isInteger(principalId)) {
            return createResponse(400, {
                statusCode: 400,
                message: "principalId must be an integer"
            });
        }

        if (
            !content ||
            typeof content !== "object" ||
            Array.isArray(content)
        ) {
            return createResponse(400, {
                statusCode: 400,
                message: "content must be an object"
            });
        }

        const invalidContentValue = Object.values(content).some(
            (value) => typeof value !== "string"
        );

        if (invalidContentValue) {
            return createResponse(400, {
                statusCode: 400,
                message: "Every content value must be a string"
            });
        }

        const createdEvent = {
            id: crypto.randomUUID(),
            principalId,
            createdAt: new Date().toISOString(),
            body: content
        };

        await dynamodb.send(
            new PutItemCommand({
                TableName: tableName,
                Item: {
                    id: {
                        S: createdEvent.id
                    },
                    principalId: {
                        N: String(createdEvent.principalId)
                    },
                    createdAt: {
                        S: createdEvent.createdAt
                    },
                    body: {
                        M: marshalStringMap(createdEvent.body)
                    }
                }
            })
        );

        console.log("Created event:", JSON.stringify(createdEvent));

        return createResponse(201, {
            statusCode: 201,
            event: createdEvent
        });
    }
    catch (error) {
        console.error("Request processing failed:", error);

        return createResponse(500, {
            statusCode: 500,
            message: "Internal server error"
        });
    }
};