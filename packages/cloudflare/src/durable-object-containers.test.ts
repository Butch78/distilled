import { describe, expect, test } from "bun:test";
import { buildRequest } from "@distilled.cloud/core/protocol-http";
import type * as AST from "effect/SchemaAST";
import {
  CreateContainerApplicationRequest,
  PrepareContainerImageRequest,
} from "./services/containers.ts";
import { PutScriptRequest } from "./services/workers.ts";

/**
 * Durable Object-managed Containers (`scheduling_policy: "durable_object"`)
 * are declared in the Worker upload: each `metadata.containers` entry names
 * its application and maps image names — chosen by the Durable Object at
 * runtime through `ctx.container.images` — to prepared registry references.
 * The wire shape follows wrangler's `getContainerMetadata`.
 */
const request = (inputAst: AST.AST, input: unknown) =>
  buildRequest({
    input,
    inputAst,
    baseUrl: "https://api.cloudflare.com/client/v4",
  });

const jsonOf = (inputAst: AST.AST, input: unknown): unknown => {
  const body = request(inputAst, input).body as { readonly text?: string };
  if (body.text === undefined) throw new Error("request body is not JSON");
  return JSON.parse(body.text);
};

const metadataOf = async (input: unknown): Promise<any> => {
  const body = request(PutScriptRequest.ast, input).body as {
    readonly formData?: FormData;
  };
  if (!body.formData) throw new Error("request body is not multipart");
  const part = body.formData.get("metadata");
  return JSON.parse(
    typeof part === "string" ? part : await (part as Blob).text(),
  );
};

describe("putScript metadata.containers", () => {
  const image = "registry.cloudflare.com/acct/sandbox@sha256:abc";

  test("carries the application name and named images", async () => {
    const metadata = await metadataOf({
      accountId: "acct",
      scriptName: "worker",
      metadata: {
        mainModule: "index.js",
        containers: [
          {
            className: "AgentSandbox",
            name: "agent-sandbox",
            images: { node: image, python: image },
          },
        ],
      },
    });
    expect(metadata.containers).toEqual([
      {
        class_name: "AgentSandbox",
        name: "agent-sandbox",
        images: { node: image, python: image },
      },
    ]);
  });

  test("image names are user keys and are never renamed", async () => {
    // `className` and `bodyPart` are entries in the upload's key dictionary.
    const metadata = await metadataOf({
      accountId: "acct",
      scriptName: "worker",
      metadata: {
        mainModule: "index.js",
        containers: [
          {
            className: "AgentSandbox",
            name: "agent-sandbox",
            images: { className: image, bodyPart: image, fastTier: image },
          },
        ],
      },
    });
    expect(Object.keys(metadata.containers[0].images).sort()).toEqual([
      "bodyPart",
      "className",
      "fastTier",
    ]);
  });

  test("a class-only entry stays class-only", async () => {
    const metadata = await metadataOf({
      accountId: "acct",
      scriptName: "worker",
      metadata: {
        mainModule: "index.js",
        containers: [{ className: "AgentSandbox" }],
      },
    });
    expect(metadata.containers).toEqual([{ class_name: "AgentSandbox" }]);
  });
});

describe("Durable Object-managed container applications", () => {
  test("create needs no configuration, image or instance counts", () => {
    const built = request(CreateContainerApplicationRequest.ast, {
      accountId: "acct",
      name: "agent-sandbox",
      schedulingPolicy: "durable_object",
      durableObjects: { namespaceId: "ns" },
      observability: { logs: { enabled: true } },
    });
    expect(built.method).toBe("POST");
    expect(
      jsonOf(CreateContainerApplicationRequest.ast, {
        accountId: "acct",
        name: "agent-sandbox",
        schedulingPolicy: "durable_object",
        durableObjects: { namespaceId: "ns" },
        observability: { logs: { enabled: true } },
      }),
    ).toEqual({
      name: "agent-sandbox",
      scheduling_policy: "durable_object",
      durable_objects: { namespace_id: "ns" },
      observability: { logs: { enabled: true } },
    });
  });

  test("image preparation posts the reference to image-preparations", () => {
    const input = {
      accountId: "acct",
      image: "registry.cloudflare.com/acct/sandbox@sha256:abc",
    };
    const built = request(PrepareContainerImageRequest.ast, input);
    expect(built.method).toBe("POST");
    expect(new URL(built.url).pathname).toBe(
      "/client/v4/accounts/acct/containers/image-preparations",
    );
    expect(jsonOf(PrepareContainerImageRequest.ast, input)).toEqual({
      image: input.image,
    });
  });
});
