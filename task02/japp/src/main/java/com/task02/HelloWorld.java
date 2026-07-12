package com.task02;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPResponse;
import com.syndicate.deployment.annotations.lambda.LambdaHandler;
import com.syndicate.deployment.annotations.lambda.LambdaUrlConfig;
import com.syndicate.deployment.model.RetentionSetting;
import com.syndicate.deployment.model.lambda.url.AuthType;
import com.syndicate.deployment.model.lambda.url.InvokeMode;

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
@LambdaUrlConfig(
    authType = AuthType.NONE,
    invokeMode = InvokeMode.BUFFERED
)
public class HelloWorld
        implements RequestHandler<APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse> {

    private static final String HELLO_PATH = "/hello";
    private static final String GET_METHOD = "GET";

    @Override
    public APIGatewayV2HTTPResponse handleRequest(
            APIGatewayV2HTTPEvent request,
            Context context
    ) {
        String path = getPath(request);
        String method = getMethod(request);

        if (HELLO_PATH.equals(path) && GET_METHOD.equalsIgnoreCase(method)) {
            return buildResponse(
                    200,
                    createBody(200, "Hello from Lambda")
            );
        }

        String message =
                "Bad request syntax or unsupported method. Request path: "
                        + path
                        + ". HTTP method: "
                        + method;

        return buildResponse(
                400,
                createBody(400, message)
        );
    }

    private String getPath(APIGatewayV2HTTPEvent request) {
        if (request == null
                || request.getRequestContext() == null
                || request.getRequestContext().getHttp() == null
                || request.getRequestContext().getHttp().getPath() == null) {
            return "";
        }

        return request.getRequestContext().getHttp().getPath();
    }

    private String getMethod(APIGatewayV2HTTPEvent request) {
        if (request == null
                || request.getRequestContext() == null
                || request.getRequestContext().getHttp() == null
                || request.getRequestContext().getHttp().getMethod() == null) {
            return "";
        }

        return request.getRequestContext().getHttp().getMethod();
    }

    private APIGatewayV2HTTPResponse buildResponse(
            int statusCode,
            String body
    ) {
        return APIGatewayV2HTTPResponse.builder()
                .withStatusCode(statusCode)
                .withHeaders(
                        Collections.singletonMap(
                                "Content-Type",
                                "application/json"
                        )
                )
                .withBody(body)
                .build();
    }

    private String createBody(int statusCode, String message) {
        return "{"
                + "\"statusCode\": "
                + statusCode
                + ", "
                + "\"message\": \""
                + escapeJson(message)
                + "\""
                + "}";
    }

    private String escapeJson(String value) {
        if (value == null) {
            return "";
        }

        return value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n")
                .replace("\t", "\\t");
    }
}