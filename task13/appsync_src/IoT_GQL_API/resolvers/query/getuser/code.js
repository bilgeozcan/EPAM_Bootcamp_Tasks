import { util } from "@aws-appsync/utils";

export function request(ctx) {
    return {
        operation: "Query",

        query: {
            expression: "PK = :pk",

            expressionValues: {
                ":pk": {
                    S: ctx.args.email
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

    const users = items.filter(
        (item) => item._TYPE === "USER"
    );

    if (users.length === 0) {
        return null;
    }

    const devices = items
        .filter(
            (item) =>
                item._TYPE === "DEVICE"
        )
        .map(
            (item) => ({
                id: item.id,
                name: item.name,
                device_type:
                    item.device_type,
                description:
                    item.description,
                events: []
            })
        );

    return {
        id: users[0].id,
        email: users[0].email,
        name: users[0].name,
        devices
    };
}