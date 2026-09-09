export type CloudConnectorHttpResponse = {
  statusCode: number;
  headers?: {
    [key: string]: (string)[];
  };
  body?: (string) | (null);
};
