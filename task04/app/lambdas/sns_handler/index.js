"use strict";

exports.handler = async (event) => {
    console.log("SNS event:", JSON.stringify(event));

    const records = Array.isArray(event?.Records)
        ? event.Records
        : [];

    for (const record of records) {
        const message = record?.Sns?.Message;
        console.log("SNS message:", message);
    }

    return {
        processedRecords: records.length
    };
};