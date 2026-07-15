import { util } from "@aws-appsync/utils";

export function request(ctx) {
    const ownerEmail =
        ctx.args.input.owner_email;

    return {
        operation: "GetItem",
        key: {
            PK: { S: ownerEmail },
            SK: { S: ownerEmail }
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
        ctx.result._TYPE !== "USER"
    ) {
        util.error(
            "User not found. Device cannot be created without a valid user.",
            "UserNotFoundError"
        );
    }

    return ctx.result;
}