declare module "jsonld" {
  export type Document = Record<string, unknown>;
  export type ActiveContext = {
    mappings: Map<string, Document | null>;
    previousContext?: ActiveContext | null;
    "@vocab"?: string;
  };

  type Options = {
    base: string;
    documentLoader: (url: string) => Promise<{
      contextUrl: null;
      documentUrl: string;
      document: Document;
      tag: "static";
    }>;
    compactToRelative?: boolean;
  };

  const jsonld: {
    expand(input: Document | unknown[], options: Options): Promise<Document[]>;
    compact(input: Document, context: string, options: Options): Promise<Document>;
    processContext(
      active: ActiveContext | null,
      local: unknown,
      options: Options,
    ): Promise<ActiveContext>;
  };
  export default jsonld;
}
