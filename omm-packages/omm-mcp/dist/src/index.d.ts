#!/usr/bin/env node
type JsonRpcRequest = {
    jsonrpc: "2.0";
    id?: string | number | null;
    method: string;
    params?: unknown;
};
type JsonRpcResponse = {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
};
export declare function processRequest(req: JsonRpcRequest): Promise<JsonRpcResponse>;
export {};
