import { util } from "@aws-appsync/utils";

export function request(ctx) {
    const prefix =
        ctx.args.device_type +
        "#" +
        ctx.args.device_name;

    return {
        operation: "Query",

        query: {
            expression:
                "PK = :pk AND begins_with(SK, :prefix)",

            expressionValues: {
                ":pk": {
                    S: ctx.args.owner_email
                },

                ":prefix": {
                    S: prefix
                }
            }
        },

        scanIndexForward: true
    };
}

export function response(ctx) {
    if (ctx.error) {
        util.error(
            ctx.error.message,
            ctx.error.type
        );
    }

    const items =
        ctx.result.items || [];

    const devices = items.filter(
        (item) => item._TYPE === "DEVICE"
    );

    if (devices.length === 0) {
        return null;
    }

    const events = items
        .filter(
            (item) =>
                item._TYPE === "EVENT"
        )
        .map(
            (item) => ({
                id: item.id,
                state: item.state,

                meta: {
                    createdAt:
                        item.meta.createdAt,
                    message:
                        item.meta.message,
                    severity:
                        item.meta.severity
                }
            })
        );

    return {
        id: devices[0].id,
        name: devices[0].name,
        device_type:
            devices[0].device_type,
        description:
            devices[0].description,
        events
    };
}