package com.task08.sdk;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public final class OpenMeteoClient {

    private static final String FORECAST_URL =
            "https://api.open-meteo.com/v1/forecast?latitude=50.45&longitude=30.52&hourly=temperature_2m%2Crelative_humidity_2m%2Cwind_speed_10m&current=temperature_2m%2Cwind_speed_10m&timezone=Europe%2FKiev";

    private final HttpClient httpClient;

    public OpenMeteoClient() {
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    public String getLatestForecast()
            throws IOException, InterruptedException {

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(FORECAST_URL))
                .timeout(Duration.ofSeconds(20))
                .header("Accept", "application/json")
                .GET()
                .build();

        HttpResponse<String> response = httpClient.send(
                request,
                HttpResponse.BodyHandlers.ofString()
        );

        if (response.statusCode() != 200) {
            throw new IOException(
                    "Open-Meteo returned HTTP "
                            + response.statusCode()
            );
        }

        String responseBody = response.body();

        if (responseBody == null || responseBody.isBlank()) {
            throw new IOException(
                    "Open-Meteo returned an empty response"
            );
        }

        return responseBody;
    }
}