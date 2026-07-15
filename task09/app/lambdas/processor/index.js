"use strict";

const { randomUUID } = require("crypto");

const {
    DynamoDBClient
} = require("@aws-sdk/client-dynamodb");

const {
    DynamoDBDocumentClient,
    PutCommand
} = require("@aws-sdk/lib-dynamodb");

const AWSXRay = require("aws-xray-sdk-core");

const WEATHER_URL =
    "https://api.open-meteo.com/v1/forecast" +
    "?latitude=50.45" +
    "&longitude=30.52" +
    "&hourly=temperature_2m" +
    "&timezone=Europe%2FKiev";

const TABLE_NAME = process.env.target_table;

const rawDynamoClient = new DynamoDBClient({});

const tracedDynamoClient =
    AWSXRay.captureAWSv3Client(rawDynamoClient);

const documentClient = DynamoDBDocumentClient.from(
    tracedDynamoClient,
    {
        marshallOptions: {
            removeUndefinedValues: true
        }
    }
);

function getXRaySegment() {
    try {
        return AWSXRay.getSegment();
    }
    catch (error) {
        console.warn(
            "X-Ray segment is not available:",
            error.message
        );

        return null;
    }
}

async function fetchWeatherForecast() {
    const parentSegment = getXRaySegment();

    const subsegment = parentSegment
        ? parentSegment.addNewSubsegment("OpenMeteoAPI")
        : null;

    try {
        const response = await fetch(WEATHER_URL, {
            method: "GET",
            headers: {
                Accept: "application/json"
            },
            signal: AbortSignal.timeout(20000)
        });

        if (!response.ok) {
            throw new Error(
                `Open-Meteo returned HTTP ${response.status}`
            );
        }

        const weather = await response.json();

        if (
            !weather.hourly ||
            !Array.isArray(weather.hourly.time) ||
            !Array.isArray(weather.hourly.temperature_2m)
        ) {
            throw new Error(
                "Open-Meteo returned an invalid forecast"
            );
        }

        if (subsegment) {
            subsegment.addAnnotation(
                "http_status",
                response.status
            );

            subsegment.addMetadata(
                "forecast_timezone",
                weather.timezone
            );
        }

        return weather;
    }
    catch (error) {
        if (subsegment) {
            subsegment.addError(error);
        }

        throw error;
    }
    finally {
        if (subsegment) {
            subsegment.close();
        }
    }
}

function buildForecast(weather) {
    return {
        elevation: Number(weather.elevation),
        generationtime_ms:
            Number(weather.generationtime_ms),
        hourly: {
            temperature_2m:
                weather.hourly.temperature_2m,
            time:
                weather.hourly.time
        },
        hourly_units: {
            temperature_2m:
                weather.hourly_units.temperature_2m,
            time:
                weather.hourly_units.time
        },
        latitude: Number(weather.latitude),
        longitude: Number(weather.longitude),
        timezone: String(weather.timezone),
        timezone_abbreviation:
            String(weather.timezone_abbreviation),
        utc_offset_seconds:
            Number(weather.utc_offset_seconds)
    };
}

exports.handler = async (event, context) => {
    console.log(
        "Processor invoked:",
        JSON.stringify(event)
    );

    if (!TABLE_NAME) {
        throw new Error(
            "The target_table environment variable is missing"
        );
    }

    try {
        const weather = await fetchWeatherForecast();

        const item = {
            id: randomUUID(),
            forecast: buildForecast(weather)
        };

        await documentClient.send(
            new PutCommand({
                TableName: TABLE_NAME,
                Item: item
            })
        );

        console.log(
            "Weather forecast stored:",
            JSON.stringify({
                id: item.id,
                table: TABLE_NAME
            })
        );

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                statusCode: 200,
                message:
                    "Weather forecast was stored successfully",
                id: item.id,
                forecast: item.forecast
            })
        };
    }
    catch (error) {
        console.error(
            "Processor failed:",
            error
        );

        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                statusCode: 500,
                message:
                    "Unable to process the weather forecast"
            })
        };
    }
};