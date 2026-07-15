package com.task08;

import com.syndicate.deployment.annotations.lambda.LambdaLayer;
import com.syndicate.deployment.model.DeploymentRuntime;

@LambdaLayer(
    layerName = "open_meteo_sdk_layer",
    description =
            "Lightweight HTTP SDK for the Open-Meteo API",
    libraries = {"lib/open-meteo-sdk.jar"},
    runtime = DeploymentRuntime.JAVA11
)
public final class OpenMeteoSdkLayer {

    private OpenMeteoSdkLayer() {
    }
}