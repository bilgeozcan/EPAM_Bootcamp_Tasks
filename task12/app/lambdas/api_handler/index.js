import AWS from "aws-sdk";
import { randomUUID } from "node:crypto";

const cognito = new AWS.CognitoIdentityServiceProvider();
const dynamodb = new AWS.DynamoDB.DocumentClient();

const USER_POOL_ID = process.env.cup_id;
const CLIENT_ID = process.env.cup_client_id;
const TABLES_TABLE = process.env.tables_table;
const RESERVATIONS_TABLE = process.env.reservations_table;

const response = (statusCode, payload) => ({
    statusCode,
    headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Accept-Version": "*"
    },
    body: JSON.stringify(payload)
});

const parseBody = (event) => {
    if (!event || event.body === undefined || event.body === null) {
        return {};
    }

    if (typeof event.body === "object") {
        return event.body;
    }

    const raw = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;

    return raw ? JSON.parse(raw) : {};
};

const validEmail = (email) =>
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const validPassword = (password) =>
    typeof password === "string" &&
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[$%^*_-])[A-Za-z0-9$%^*_-]{12,}$/.test(password);

const signup = async (event) => {
    let createdUsername = null;

    try {
        const {
            firstName,
            lastName,
            email,
            password
        } = parseBody(event);

        if (
            typeof firstName !== "string" ||
            !firstName.trim() ||
            typeof lastName !== "string" ||
            !lastName.trim() ||
            !validEmail(email) ||
            !validPassword(password)
        ) {
            return response(400, {
                error: "Invalid sign-up request"
            });
        }

        createdUsername = email;

        await cognito.adminCreateUser({
            UserPoolId: USER_POOL_ID,
            Username: email,
            MessageAction: "SUPPRESS",
            TemporaryPassword: "Tmp1$Temporary_2026",
            UserAttributes: [
                {
                    Name: "email",
                    Value: email
                },
                {
                    Name: "email_verified",
                    Value: "true"
                },
                {
                    Name: "given_name",
                    Value: firstName.trim()
                },
                {
                    Name: "family_name",
                    Value: lastName.trim()
                }
            ]
        }).promise();

        await cognito.adminSetUserPassword({
            UserPoolId: USER_POOL_ID,
            Username: email,
            Password: password,
            Permanent: true
        }).promise();

        return response(200, {
            message: "User successfully registered"
        });
    }
    catch (error) {
        console.error("Sign-up error", error);

        if (
            createdUsername &&
            error.code !== "UsernameExistsException"
        ) {
            try {
                await cognito.adminDeleteUser({
                    UserPoolId: USER_POOL_ID,
                    Username: createdUsername
                }).promise();
            }
            catch (cleanupError) {
                console.error("User cleanup error", cleanupError);
            }
        }

        return response(400, {
            error: error.code === "UsernameExistsException"
                ? "User already exists"
                : "Unable to register user"
        });
    }
};

const signin = async (event) => {
    try {
        const { email, password } = parseBody(event);

        if (!validEmail(email) || typeof password !== "string") {
            return response(400, {
                error: "Invalid credentials"
            });
        }

        const result = await cognito.adminInitiateAuth({
            AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
            UserPoolId: USER_POOL_ID,
            ClientId: CLIENT_ID,
            AuthParameters: {
                USERNAME: email,
                PASSWORD: password
            }
        }).promise();

        const idToken =
            result.AuthenticationResult &&
            result.AuthenticationResult.IdToken;

        if (!idToken) {
            return response(400, {
                error: "Authentication failed"
            });
        }

        return response(200, {
            idToken
        });
    }
    catch (error) {
        console.error("Sign-in error", error);

        return response(400, {
            error: "Invalid credentials"
        });
    }
};

const getTables = async () => {
    try {
        const result = await dynamodb.scan({
            TableName: TABLES_TABLE
        }).promise();

        const tables = (result.Items || []).map((item) => {
            const table = {
                id: Number(item.id),
                number: Number(item.number),
                places: Number(item.places),
                isVip: Boolean(item.isVip)
            };

            if (item.minOrder !== undefined) {
                table.minOrder = Number(item.minOrder);
            }

            return table;
        });

        return response(200, {
            tables
        });
    }
    catch (error) {
        console.error("Get tables error", error);

        return response(400, {
            error: "Unable to retrieve tables"
        });
    }
};

const createTable = async (event) => {
    try {
        const {
            id,
            number,
            places,
            isVip,
            minOrder
        } = parseBody(event);

        if (
            !Number.isInteger(id) ||
            !Number.isInteger(number) ||
            !Number.isInteger(places) ||
            places <= 0 ||
            typeof isVip !== "boolean" ||
            (
                minOrder !== undefined &&
                (!Number.isInteger(minOrder) || minOrder < 0)
            )
        ) {
            return response(400, {
                error: "Invalid table data"
            });
        }

        const item = {
            id: String(id),
            number,
            places,
            isVip
        };

        if (minOrder !== undefined) {
            item.minOrder = minOrder;
        }

        await dynamodb.put({
            TableName: TABLES_TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(id)"
        }).promise();

        return response(200, {
            id
        });
    }
    catch (error) {
        console.error("Create table error", error);

        return response(400, {
            error: error.code === "ConditionalCheckFailedException"
                ? "Table already exists"
                : "Unable to create table"
        });
    }
};

const getTable = async (tableId) => {
    try {
        if (!/^\d+$/.test(String(tableId || ""))) {
            return response(400, {
                error: "Invalid table ID"
            });
        }

        const result = await dynamodb.get({
            TableName: TABLES_TABLE,
            Key: {
                id: String(tableId)
            }
        }).promise();

        if (!result.Item) {
            return response(400, {
                error: "Table not found"
            });
        }

        const table = {
            id: Number(result.Item.id),
            number: Number(result.Item.number),
            places: Number(result.Item.places),
            isVip: Boolean(result.Item.isVip)
        };

        if (result.Item.minOrder !== undefined) {
            table.minOrder = Number(result.Item.minOrder);
        }

        return response(200, table);
    }
    catch (error) {
        console.error("Get table error", error);

        return response(400, {
            error: "Unable to retrieve table"
        });
    }
};

const validDate = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value);

const validTime = (value) =>
    typeof value === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const createReservation = async (event) => {
    try {
        const {
            tableNumber,
            clientName,
            phoneNumber,
            date,
            slotTimeStart,
            slotTimeEnd
        } = parseBody(event);

        if (
            !Number.isInteger(tableNumber) ||
            typeof clientName !== "string" ||
            !clientName.trim() ||
            typeof phoneNumber !== "string" ||
            !phoneNumber.trim() ||
            !validDate(date) ||
            !validTime(slotTimeStart) ||
            !validTime(slotTimeEnd) ||
            slotTimeStart >= slotTimeEnd
        ) {
            return response(400, {
                error: "Invalid reservation data"
            });
        }

        const tablesResult = await dynamodb.scan({
            TableName: TABLES_TABLE
        }).promise();

        const tableExists = (tablesResult.Items || []).some(
            (item) => Number(item.number) === tableNumber
        );

        if (!tableExists) {
            return response(400, {
                error: "Table not found"
            });
        }

        const reservationsResult = await dynamodb.scan({
            TableName: RESERVATIONS_TABLE
        }).promise();

        const conflict = (reservationsResult.Items || []).some(
            (item) =>
                Number(item.tableNumber) === tableNumber &&
                item.date === date &&
                slotTimeStart < item.slotTimeEnd &&
                item.slotTimeStart < slotTimeEnd
        );

        if (conflict) {
            return response(400, {
                error: "Reservation overlaps with an existing reservation"
            });
        }

        const reservationId = randomUUID();

        await dynamodb.put({
            TableName: RESERVATIONS_TABLE,
            Item: {
                id: reservationId,
                tableNumber,
                clientName: clientName.trim(),
                phoneNumber: phoneNumber.trim(),
                date,
                slotTimeStart,
                slotTimeEnd
            }
        }).promise();

        return response(200, {
            reservationId
        });
    }
    catch (error) {
        console.error("Create reservation error", error);

        return response(400, {
            error: "Unable to create reservation"
        });
    }
};

const getReservations = async () => {
    try {
        const result = await dynamodb.scan({
            TableName: RESERVATIONS_TABLE
        }).promise();

        const reservations = (result.Items || []).map((item) => ({
            tableNumber: Number(item.tableNumber),
            clientName: item.clientName,
            phoneNumber: item.phoneNumber,
            date: item.date,
            slotTimeStart: item.slotTimeStart,
            slotTimeEnd: item.slotTimeEnd
        }));

        return response(200, {
            reservations
        });
    }
    catch (error) {
        console.error("Get reservations error", error);

        return response(400, {
            error: "Unable to retrieve reservations"
        });
    }
};

export const handler = async (event) => {
    console.log("Event", JSON.stringify(event));

    const method = event && event.httpMethod;
    const path = event && event.path;

    try {
        if (method === "OPTIONS") {
            return response(200, {});
        }

        if (path === "/signup" && method === "POST") {
            return await signup(event);
        }

        if (path === "/signin" && method === "POST") {
            return await signin(event);
        }

        if (path === "/tables" && method === "GET") {
            return await getTables();
        }

        if (path === "/tables" && method === "POST") {
            return await createTable(event);
        }

        if (
            method === "GET" &&
            /^\/tables\/[^/]+$/.test(path || "")
        ) {
            const tableId =
                event.pathParameters &&
                event.pathParameters.tableId
                    ? event.pathParameters.tableId
                    : path.split("/")[2];

            return await getTable(tableId);
        }

        if (path === "/reservations" && method === "POST") {
            return await createReservation(event);
        }

        if (path === "/reservations" && method === "GET") {
            return await getReservations();
        }

        return response(400, {
            error: "Unsupported request"
        });
    }
    catch (error) {
        console.error("Unhandled handler error", error);

        return response(400, {
            error: "Unable to process request"
        });
    }
};