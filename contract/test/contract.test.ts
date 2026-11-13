import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContractDocument } from '../types.js';
import { validateContractDocument } from '../tools/validate-contract.js';

const contractPath = new URL('../contract.json', import.meta.url);
const schemaPath = new URL('../schema/contract.schema.json', import.meta.url);

function loadContract(): ContractDocument {
  return JSON.parse(readFileSync(contractPath, 'utf8')) as ContractDocument;
}

function loadSchema(): unknown {
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;
}

describe('contract.json — schema', (): void => {
  it('validates against contract.schema.json', (): void => {
    const errors = validateContractDocument(loadContract(), loadSchema());
    expect(errors).toEqual([]);
  });

  it('rejects a document with a removed section', (): void => {
    const broken: unknown = { ...(loadContract() as object), events: undefined };
    const errors = validateContractDocument(broken, loadSchema());
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an event with an unknown return kind', (): void => {
    const doc = loadContract();
    const broken: unknown = {
      ...doc,
      events: doc.events.map((e) =>
        e.event === 'GetInfo' ? { ...e, returns: 'status' } : e,
      ),
    };
    const errors = validateContractDocument(broken, loadSchema());
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('contract.json — §5.2 event-binding invariants', (): void => {
  const doc = loadContract();
  const events = doc.events;
  const names = events.map((e): string => e.event);

  it('contains exactly the 15 dispatchers', (): void => {
    expect(names).toHaveLength(15);
    expect(names).toEqual([
      'GetDirectoryPageNumber', 'GetNameAndLink', 'GetInfo',
      'BeforeUpdateList', 'AfterUpdateList', 'TaskStart',
      'GetPageNumber', 'GetImageURL', 'BeforeDownloadImage',
      'DownloadImage', 'SaveImage', 'AfterImageSaved',
      'Login', 'AccountState', 'CheckSite',
    ]);
  });

  it('returns codes for GetDirectoryPageNumber/GetNameAndLink/GetInfo only', (): void => {
    const codeEvents = events
      .filter((e): boolean => e.returns === 'code')
      .map((e): string => e.event);
    expect(codeEvents.sort()).toEqual(
      ['GetDirectoryPageNumber', 'GetInfo', 'GetNameAndLink'].sort(),
    );
  });

  it('SaveImage returns a string; every other non-code event returns a boolean', (): void => {
    for (const e of events) {
      if (e.event === 'SaveImage') {
        expect(e.returns).toBe('string');
      } else if (e.returns !== 'code') {
        expect(e.returns).toBe('boolean');
      }
    }
  });

  it('PAGENUMBER is the only read-back global (and only for GetDirectoryPageNumber)', (): void => {
    for (const e of events) {
      for (const g of e.readBack) {
        expect(g).toBe('PAGENUMBER');
        expect(e.event).toBe('GetDirectoryPageNumber');
      }
    }
  });

  it('binds no ACCOUNT global anywhere', (): void => {
    for (const e of events) {
      expect(e.globals).not.toContain('ACCOUNT');
    }
  });

  it('readBack globals are always a subset of the bound globals', (): void => {
    for (const e of events) {
      for (const g of e.readBack) {
        expect(e.globals).toContain(g);
      }
    }
  });

  it('BeforeDownloadImage is push-only', (): void => {
    const bdi = events.find((e): boolean => e.event === 'BeforeDownloadImage');
    expect(bdi?.pushOnly).toBe(true);
  });

  it('binds account-status constants for Login/AccountState/CheckSite only', (): void => {
    const withAccount = events
      .filter((e): boolean => e.constants === 'account-status')
      .map((e): string => e.event);
    expect(withAccount.sort()).toEqual(['AccountState', 'CheckSite', 'Login'].sort());
  });

  it('carries the FMD2 status constants (§5.2)', (): void => {
    expect(doc.statusConstants.netStatus).toEqual({
      no_error: 0,
      net_problem: 1,
      information_not_found: 2,
    });
    expect(doc.statusConstants.accountStatus).toEqual([
      'asUnknown', 'asChecking', 'asValid', 'asInvalid',
    ]);
  });

  it('declares the MANGAINFO surface and read-only TASK fields', (): void => {
    for (const f of ['Title', 'ChapterLinks', 'ChapterNames', 'Link']) {
      expect(doc.mangaInfoFields).toContain(f);
    }
    const readOnly = doc.taskFields
      .filter((f): boolean => f.access === 'read-only')
      .map((f): string => f.name);
    expect(readOnly).toContain('ChapterLinks');
    expect(readOnly).toContain('CurrentMaxFileNameLength');
  });
});
