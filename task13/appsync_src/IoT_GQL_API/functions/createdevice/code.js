import { util } from "@aws-appsync/utils";

export function request(ctx) {
    const input = ctx.args.input;

    const id = util.autoId();

    const sk =
        input.device_type +
        "#" +
        input.device_name;

    return {
        operation: "PutItem",
        key: {
            PK: { S: input.owner_email },
            SK: { S: sk }
        },
        attributeValues: {
            id: { S: id },
            name: { S: input.device_name },
            device_type: {
                S: input.device_type
            },
            description: {
                S: input.description || ""
            },
            _TYPE: { S: "DEVICE" }
        },
        condition: {
            expression:
                "attribute_not_exists(PK) AND attribute_not_exists(SK)"
        }
    };
}

export function response(ctx) {
    if (ctx.error) {
        if (
            ctx.error.type.indexOf(
                "ConditionalCheckFailed"
            ) >= 0
        ) {
            util.error(
                "The device for the user with this email already exists.",
                "DeviceAlreadyExistsError"
            );
        }

        util.error(
            ctx.error.message,
            ctx.error.type
        );
    }

    return {
        id: ctx.result.id,
        name: ctx.result.name,
        device_type:
            ctx.result.device_type,
        description:
            ctx.result.description,
        events: []
    };
}