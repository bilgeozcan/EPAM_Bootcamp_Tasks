import { util } from "@aws-appsync/utils";

export function request(ctx) {
    const input = ctx.args.input;

    const sk =
        input.device_type +
        "#" +
        input.device_name;

    return {
        operation: "GetItem",
        key: {
            PK: {
                S: input.device_owner_email
            },
            SK: { S: sk }
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

    if (
        !ctx.result ||
        ctx.result._TYPE !== "DEVICE"
    ) {
        util.error(
            "Device not found. Event cannot be created without a valid device.",
            "DeviceNotFoundError"
        );
    }

    return ctx.result;
}