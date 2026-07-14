"use strict";

exports.handler = async (event) => {
    console.log("SQS event:", JSON.stringify(event));

    const records = Array.isArray(event?.Records)
        ? event.Records
        : [];

    for (const record of records) {
        console.log("SQS message:", record.body);
    }

    return {
        batchItemFailures: []
    };
};