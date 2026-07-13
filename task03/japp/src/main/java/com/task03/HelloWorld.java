package com.task03;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.syndicate.deployment.annotations.lambda.LambdaHandler;
import com.syndicate.deployment.model.RetentionSetting;

import java.util.Collections;

@LambdaHandler(
    lambdaName = "hello_world",
    roleName = "hello_world-role",
    memory = 256,
    timeout = 30,
    isPublishVersion = true,
    aliasName = "${lambdas_alias_name}",
    logsExpiration = RetentionSetting.SYNDICATE_ALIASES_SPECIFIED
)
public class HelloWorld
        implements RequestHandler<
        APIGatewayProxyRequestEvent,
        APIGatewayProxyResponseEvent> {

    private static final String RESPONSE_BODY =
            "{\"statusCode\": 200, \"message\": \"Hello from Lambda\"}";

    @Override
    public APIGatewayProxyResponseEvent handleRequest(
            APIGatewayProxyRequestEvent request,
            Context context
    ) {
        APIGatewayProxyResponseEvent response =
                new APIGatewayProxyResponseEvent();

        response.setStatusCode(200);
        response.setHeaders(
                Collections.singletonMap(
                        "Content-Type",
                        "application/json"
                )
        );
        response.setBody(RESPONSE_BODY);

        return response;
    }
}