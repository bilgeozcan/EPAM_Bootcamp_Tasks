import { util } from '@aws-appsync/utils';

export function request(ctx) {
    const id = util.autoId();
    const createdAt = util.time.nowISO8601();

    return {
        operation: "PutItem",
        key: util.dynamodb.toMapValues({
            id
        }),
        attributeValues: util.dynamodb.toMapValues({
            userId: ctx.args.userId,
            createdAt,
            payLoad: ctx.args.payLoad
        }),
        condition: {
            expression: "attribute_not_exists(id)"
        }
    };
}

export function response(ctx) {
    if (ctx.error) {
        return util.error(ctx.error.message, ctx.error.type);
    }

    return ctx.result;
}