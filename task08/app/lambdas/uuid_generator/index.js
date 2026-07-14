const { randomUUID } = require("crypto");
const {
    S3Client,
    PutObjectCommand
} = require("@aws-sdk/client-s3");

const s3 = new S3Client({});

exports.handler = async () => {
    const executionStartTime = new Date().toISOString();

    const ids = Array.from(
        { length: 10 },
        () => randomUUID()
    );

    const bucketName = process.env.target_bucket;

    if (!bucketName) {
        throw new Error(
            "target_bucket environment variable is not configured"
        );
    }

    const objectKey = executionStartTime;
    const fileContent = JSON.stringify({ ids });

    await s3.send(
        new PutObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
            Body: fileContent,
            ContentType: "application/json"
        })
    );

    console.log(
        JSON.stringify({
            message: "UUID file created",
            bucket: bucketName,
            key: objectKey,
            ids
        })
    );

    return {
        statusCode: 200,
        body: JSON.stringify({
            ids,
            bucket: bucketName,
            key: objectKey
        })
    };
};