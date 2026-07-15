import { util } from "@aws-appsync/utils";

export function request(ctx) {
    const email = ctx.args.input.email;
    const name = ctx.args.input.name;
    const id = util.autoId();

    return {
        operation: "PutItem",
        key: {
            PK: { S: email },
            SK: { S: email }
        },
        attributeValues: {
            id: { S: id },
            email: { S: email },
            name: { S: name },
            _TYPE: { S: "USER" }
        },
        condition: {
            expression: "attribute_not_exists(PK)"
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
                "User with this email already exists. Please try another.",
                "UserAlreadyExistsError"
            );
        }

        util.error(
            ctx.error.message,
            ctx.error.type
        );
    }

    return {
        id: ctx.result.id,
        email: ctx.result.email,
        name: ctx.result.name,
        devices: []
    };
}