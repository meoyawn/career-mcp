import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.ts";

describe("MCP transaction boundary", () => {
  test("compound reads execute once per tool call, including when the same server handles subsequent calls", async () => {
    let transactions = 0;
    function empty<T>(): D1Result<T> {
      return { success: true, results: [], meta: {
        duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0,
      } };
    }
    function prepare(): D1PreparedStatement {
      return {
        bind: prepare,
        async first() { transactions++; return null; },
        async all<T>() { transactions++; return empty<T>(); },
        async run<T>() { transactions++; return empty<T>(); },
        raw() { throw new Error("Raw queries must not bypass the transaction boundary."); },
      };
    }
    const database: D1Database = {
      prepare,
      async batch<T>(statements: D1PreparedStatement[]) {
        transactions++;
        return statements.map(() => empty<T>());
      },
      exec() { throw new Error("Unprepared SQL must not bypass the transaction boundary."); },
      withSession() { throw new Error("A session must not bypass the transaction boundary."); },
      dump() { throw new Error("Tools must not export the database."); },
    };
    const server = createServer(database, crypto.randomUUID());
    const client = new Client({ name: "transaction-boundary", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const name of ["get_lead_context", "get_application_context", "get_pipeline"]) {
        for (let attempt = 0; attempt < 2; attempt++) {
          transactions = 0;
          const result = await client.callTool({ name, arguments: {} });
          assert.ok(!result.isError, JSON.stringify(result.content));
          assert.equal(transactions, 1, `${name} must read all its data in one transaction`);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
