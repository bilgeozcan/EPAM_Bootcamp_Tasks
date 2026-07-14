import { util } from '@aws-appsync/utils';

export function request(ctx) {
    return {
        operation: "GetItem",
        key: util.dynamodb.toMapValues({
            id: ctx.args.id
        }),
        consistentRead: true
    };
}

export function response(ctx) {
    if (ctx.error) {
        return util.error(ctx.error.message, ctx.error.type);
    }

    return ctx.result;
}