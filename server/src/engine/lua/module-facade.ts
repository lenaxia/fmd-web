import type { LuaModuleDescriptor, ModuleOptionDescriptor } from '@fmd/contract';
import { toBool, toInteger, toStr } from './base-globals.js';
import type { FacadeBridge, FacadeSpec } from './facade.js';

/**
 * The `NewWebsiteModule()` object surface (§5.1,
 * `LuaWebsiteModules.pas:991-1039` + registration table :954-985):
 * typed identity/props, event-name string props, options API with combobox
 * INDEX semantics, Storage facade, Account (only when AccountSupport=true),
 * case-sensitive keys, unknown keys silently no-op.
 */

type OptionValue = boolean | string | number;

export interface OptionBacking {
  readonly kind: 'checkbox' | 'edit' | 'spinedit' | 'combobox';
  readonly caption: string;
  defaultValue: OptionValue;
  readonly items: readonly string[] | undefined;
}

const EVENT_PROP_PREFIX = 'On';
const EVENT_NAMES: readonly string[] = [
  'BeforeUpdateList',
  'AfterUpdateList',
  'GetDirectoryPageNumber',
  'GetNameAndLink',
  'GetInfo',
  'TaskStart',
  'GetPageNumber',
  'GetImageURL',
  'BeforeDownloadImage',
  'DownloadImage',
  'SaveImage',
  'AfterImageSaved',
  'Login',
  'AccountState',
  'CheckSite',
];

export class ModuleBacking {
  id = '';
  name = '';
  rootURL = '';
  category = '';
  lastUpdated = '';
  accountSupport = false;

  maxTaskLimit = 0;
  maxThreadPerTaskLimit = 0;
  maxConnectionLimit = 0;
  activeTaskCount = 0;
  activeConnectionCount = 0;
  currentDirectoryIndex = 0;
  tag = 0;
  totalDirectory = 0;

  sortedList = false;
  informationAvailable = false;
  favoriteAvailable = false;
  dynamicPageLink = false;

  readonly options = new Map<string, OptionBacking>();
  readonly eventHandlers: Record<string, string> = {};

  readonly storage = new Map<string, string>();
  storageText = '';
  storageTag = 0;
  storageEnable = false;
  storageStatus = '';

  accountEnabled = false;
  accountUsername = '';
  accountPassword = '';
  accountStatus = 0; // asUnknown
  accountCookies = '';

  /** Build the Lua facade spec backed by this registration. */
  spec(bridge: FacadeBridge): FacadeSpec {
    const storageFacadeId = bridge.create('', {
      get: (k) => {
        if (k === 'Text') {
          return this.storageText;
        }
        if (k === 'Tag') {
          return this.storageTag;
        }
        if (k === 'Enable') {
          return this.storageEnable;
        }
        if (k === 'Status') {
          return this.storageStatus;
        }
        if (k === 'Remove') {
          return (key: unknown) => {
            this.storage.delete(toStr(key));
            return undefined;
          };
        }
        if (k === 'Free' || k === 'Destroy') {
          return () => undefined;
        }
        return this.storage.get(toStr(k)); // string keys are the KV map (§5.3)
      },
      set: (k, v) => {
        if (k === 'Text') {
          this.storageText = toStr(v);
          return;
        }
        if (k === 'Tag') {
          this.storageTag = toInteger(v);
          return;
        }
        if (k === 'Enable') {
          this.storageEnable = toBool(v);
          return;
        }
        if (k === 'Status') {
          this.storageStatus = toStr(v);
          return;
        }
        this.storage.set(toStr(k), toStr(v));
      },
    });

    let accountFacadeId: number | undefined;
    const guardianFacadeId = bridge.create('', { get: () => undefined, set: () => undefined });

    const methods: Record<string, (...args: unknown[]) => unknown> = {
      AddOptionCheckBox: (name: unknown, caption: unknown, def: unknown) => {
        this.setOption(
          toStr(name),
          { kind: 'checkbox', caption: toStr(caption), defaultValue: toBool(def), items: undefined },
        );
        return undefined;
      },
      AddOptionEdit: (name: unknown, caption: unknown, def: unknown) => {
        this.setOption(toStr(name), { kind: 'edit', caption: toStr(caption), defaultValue: toStr(def), items: undefined });
        return undefined;
      },
      AddOptionSpinEdit: (name: unknown, caption: unknown, def: unknown) => {
        this.setOption(
          toStr(name),
          { kind: 'spinedit', caption: toStr(caption), defaultValue: toInteger(def), items: undefined },
        );
        return undefined;
      },
      AddOptionComboBox: (name: unknown, caption: unknown, items: unknown, def: unknown) => {
        // combobox stores the selected INDEX; items are a comma-split string
        this.setOption(toStr(name), {
          kind: 'combobox',
          caption: toStr(caption),
          defaultValue: toInteger(def),
          items: toStr(items).split(','),
        });
        return undefined;
      },
      AddServerCookies: () => undefined,
      GetServerCookies: () => '',
      RemoveCookies: () => undefined,
      ClearCookies: () => undefined,
      GetOption: (name: unknown) => {
        const option = this.options.get(toStr(name));
        return option === undefined ? undefined : option.defaultValue;
      },
    };

    return {
      get: (key) => {
        if (typeof key === 'number') {
          return undefined;
        }
        switch (key) {
          case 'ID':
            return this.id;
          case 'Name':
            return this.name;
          case 'RootURL':
            return this.rootURL;
          case 'Category':
            return this.category;
          case 'LastUpdated':
            return this.lastUpdated;
          case 'MaxTaskLimit':
            return this.maxTaskLimit;
          case 'MaxThreadPerTaskLimit':
            return this.maxThreadPerTaskLimit;
          case 'MaxConnectionLimit':
            return this.maxConnectionLimit;
          case 'ActiveTaskCount':
            return this.activeTaskCount;
          case 'ActiveConnectionCount':
            return this.activeConnectionCount;
          case 'CurrentDirectoryIndex':
            return this.currentDirectoryIndex;
          case 'Tag':
            return this.tag;
          case 'TotalDirectory':
            return this.totalDirectory;
          case 'SortedList':
            return this.sortedList;
          case 'InformationAvailable':
            return this.informationAvailable;
          case 'FavoriteAvailable':
            return this.favoriteAvailable;
          case 'DynamicPageLink':
            return this.dynamicPageLink;
          case 'AccountSupport':
            return this.accountSupport;
          default:
            break;
        }
        if (isEventProp(key)) {
          return this.eventHandlers[key.slice(EVENT_PROP_PREFIX.length)] ?? '';
        }
        const method = methods[key];
        if (method !== undefined) {
          return method;
        }
        return undefined; // unknown key: silent no-op (LuaClass.pas:94-169)
      },
      set: (key, value) => {
        if (typeof key !== 'string') {
          return;
        }
        switch (key) {
          case 'ID':
            this.id = toStr(value);
            return;
          case 'Name':
            this.name = toStr(value);
            return;
          case 'RootURL':
            this.rootURL = toStr(value);
            return;
          case 'Category':
            this.category = toStr(value);
            return;
          case 'LastUpdated':
            this.lastUpdated = toStr(value);
            return;
          case 'MaxTaskLimit':
            this.maxTaskLimit = toInteger(value);
            return;
          case 'MaxThreadPerTaskLimit':
            this.maxThreadPerTaskLimit = toInteger(value);
            return;
          case 'MaxConnectionLimit':
            this.maxConnectionLimit = toInteger(value);
            return;
          case 'ActiveTaskCount':
            this.activeTaskCount = toInteger(value);
            return;
          case 'ActiveConnectionCount':
            this.activeConnectionCount = toInteger(value);
            return;
          case 'CurrentDirectoryIndex':
            this.currentDirectoryIndex = toInteger(value);
            return;
          case 'Tag':
            this.tag = toInteger(value);
            return;
          case 'TotalDirectory':
            this.totalDirectory = toInteger(value);
            return;
          case 'SortedList':
            this.sortedList = toBool(value);
            return;
          case 'InformationAvailable':
            this.informationAvailable = toBool(value);
            return;
          case 'FavoriteAvailable':
            this.favoriteAvailable = toBool(value);
            return;
          case 'DynamicPageLink':
            this.dynamicPageLink = toBool(value);
            return;
          case 'AccountSupport':
            this.accountSupport = toBool(value);
            return;
          default:
            break;
        }
        if (isEventProp(key)) {
          // event binding mechanism: handler name string (§5.1)
          this.eventHandlers[key.slice(EVENT_PROP_PREFIX.length)] = toStr(value);
        }
        // unknown keys: silent no-op
      },
      sub: (key) => {
        if (key === 'Storage') {
          return storageFacadeId;
        }
        if (key === 'Guardian') {
          return guardianFacadeId;
        }
        if (key === 'Account') {
          // Account object exists only when AccountSupport=true
          // (LuaWebsiteModules.pas:1035-1036)
          if (!this.accountSupport) {
            return undefined;
          }
          if (accountFacadeId === undefined) {
            accountFacadeId = bridge.create('', {
              get: (k) => {
                if (k === 'Enabled') {
                  return this.accountEnabled;
                }
                if (k === 'Username') {
                  return this.accountUsername;
                }
                if (k === 'Password') {
                  return this.accountPassword;
                }
                if (k === 'Status') {
                  return this.accountStatus;
                }
                if (k === 'Cookies') {
                  return this.accountCookies;
                }
                return undefined;
              },
              set: (k, v) => {
                if (k === 'Enabled') {
                  this.accountEnabled = toBool(v);
                } else if (k === 'Username') {
                  this.accountUsername = toStr(v);
                } else if (k === 'Password') {
                  this.accountPassword = toStr(v);
                } else if (k === 'Status') {
                  this.accountStatus = toInteger(v);
                } else if (k === 'Cookies') {
                  this.accountCookies = toStr(v);
                }
              },
            });
          }
          return accountFacadeId;
        }
        return undefined;
      },
    };
  }

  /** Duplicate option names replace their entry (Options dupIgnore). */
  private setOption(name: string, backing: OptionBacking): void {
    if (name === '') {
      return;
    }
    this.options.set(name, backing);
  }

  /** Rebuild an event-time MODULE backing from an Init-pass descriptor. */
  static fromDescriptor(descriptor: LuaModuleDescriptor): ModuleBacking {
    const backing = new ModuleBacking();
    backing.id = descriptor.id;
    backing.name = descriptor.name;
    backing.rootURL = descriptor.rootURL;
    backing.category = descriptor.category;
    backing.accountSupport = descriptor.accountSupport;
    for (const option of descriptor.options) {
      backing.options.set(option.name, {
        kind: option.kind,
        caption: option.name,
        defaultValue: option.defaultValue,
        items: option.items,
      });
    }    for (const [event, handler] of Object.entries(descriptor.eventHandlers)) {
      backing.eventHandlers[`On${event}`] = handler;
    }
    return backing;
  }

  /** Typed projection (§5.1) — registrations missing ID/Name are dropped by the registry. */
  toDescriptor(sourceFile: string): LuaModuleDescriptor {
    const options: ModuleOptionDescriptor[] = [];
    for (const [name, option] of this.options) {
      const descriptor: ModuleOptionDescriptor =
        option.items !== undefined
          ? { name, kind: option.kind, defaultValue: option.defaultValue, items: option.items }
          : { name, kind: option.kind, defaultValue: option.defaultValue };
      options.push(descriptor);
    }
    const eventHandlers: Record<string, string> = {};
    for (const [prop, handler] of Object.entries(this.eventHandlers)) {
      if (handler !== '') {
        eventHandlers[stripOnPrefix(prop)] = handler;
      }
    }
    return {
      id: this.id,
      name: this.name,
      rootURL: this.rootURL,
      category: this.category,
      accountSupport: this.accountSupport,
      options,
      eventHandlers,
      sourceFile,
    };
  }
}

function stripOnPrefix(prop: string): string {
  return prop.startsWith(EVENT_PROP_PREFIX) ? prop.slice(EVENT_PROP_PREFIX.length) : prop;
}

/** 'OnGetInfo' etc. — the binding-mechanism string props (§5.1). */
function isEventProp(key: string): boolean {
  return key.startsWith(EVENT_PROP_PREFIX) && EVENT_NAMES.includes(key.slice(EVENT_PROP_PREFIX.length));
}
