import { util } from "@aws-appsync/utils";

export function request(ctx) {
    const input = ctx.args.input;

    const validStates = [
        "PENDING",
        "OK",
        "ALARM"
    ];

    if (
        validStates.indexOf(
            input.state
        ) < 0
    ) {
        util.error(
            "Invalid input for event state. Allowed states '[PENDING, OK, ALARM]'.",
            "InvalidEventStateError"
        );
    }

    const id = util.autoId();
    const createdAt =
        util.time.nowISO8601();

    const sk =
        input.device_type +
        "#" +
        input.device_name +
        "#" +
        id;

    const meta = input.meta || {};

    return {
        operation: "PutItem",
        key: {
            PK: {
                S: input.device_owner_email
            },
            SK: { S: sk }
        },
        attributeValues: {
            id: { S: id },
            state: { S: input.state },

            meta: {
                M: {
                    createdAt: {
                        S: createdAt
                    },
                    message: {
                        S: meta.message || ""
                    },
                    severity: {
                        S: meta.severity || ""
                    }
                }
            },

            _TYPE: { S: "EVENT" }
        }
    };
}

export function response(ctx) {
    if (ctx.error) {
        util.error(
            ctx.error.message,
            ctx.error.type
        );
    }

    return {
        id: ctx.result.id,
        state: ctx.result.state,

        meta: {
            createdAt:
                ctx.result.meta.createdAt,
            message:
                ctx.result.meta.message,
            severity:
                ctx.result.meta.severity
        }
    };
}