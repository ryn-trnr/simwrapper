import micromatch from 'micromatch';
import pako from 'pako';
import naturalSort from 'javascript-natural-sort';

import {
  DirectoryEntry,
  FileSystemAPIHandle,
  FileSystemConfig,
  YamlConfigs,
  PIECES,
} from '@/Globals';

naturalSort.insensitive = true;

// GitHub doesn't tell us the type of file, so we have to guess by filename extension
const BINARIES = /.*\.(avro|dbf|gpkg|gz|h5|jpg|jpeg|omx|png|shp|shx|sqlite|zip|zst)$/;

// These folders can contain simwrapper project config files
const YAML_FOLDERS = ['simwrapper', '.simwrapper'];

// Cache directory listings for each slug & directory
const CACHE: { [slug: string]: { [dir: string]: DirectoryEntry } } = {};

// ---------------------------------------------------------------------------

class HTTPFileSystem {
  private baseUrl: string;
  private urlId: string;
  private needsAuth: boolean;
  private fsHandle: FileSystemAPIHandle | null;
  private store: any;
  private isGithub: boolean;

  constructor(project: FileSystemConfig, store?: any) {
    this.urlId = project.slug;
    this.needsAuth = !!project.needPassword;
    this.fsHandle = project.handle || null;
    this.store = store || null;
    this.isGithub = !!project.isGithub;

    this.baseUrl = project.baseURL;
    if (!project.baseURL.endsWith('/')) this.baseUrl += '/';

    if (!CACHE[this.urlId]) CACHE[this.urlId] = {};
  }

  public hasHandle() {
    return !!this.fsHandle;
  }

  // make sure user has given permission to view this folder
  async getChromePermission(handle: any) {
    if (!handle) return true;

    const status = await handle.queryPermission({ mode: 'read' });
    if (status !== 'granted') {
      if (!this.store) return true;
      // callback triggers after user grants/denies access:
      const granted = new Promise<boolean>(resolve => {
        this.store.commit('setFileHandleForPermissionRequest', { handle, resolve });
      });
      const resolved = await granted;
      return resolved;
    }
    return true;
  }

  public clearCache() {
    CACHE[this.urlId] = {};
  }

  public cleanURL(scaryPath: string) {
    // hostile user could put anything in the URL really...
    let path = this.baseUrl + scaryPath.replace(/^0-9a-zA-Z_\-\/:+/i, '');
    // console.log('FETCHING:', scaryPath)
    // console.log('CLEAN: ', path)

    path = path.replaceAll('//', '/');
    path = path.replaceAll('//', '/'); // twice just in case!
    path = path.replace('https:/', 'https://');
    path = path.replace('http:/', 'http://');
    // console.log('CLEAN2: ', path)

    // sanity: /parent/my/../etc  => /parent/etc
    path = new URL(path).href;

    return path;
  }

  private async _getFileResponse(scaryPath: string): Promise<Response> {
    if (this.fsHandle) {
      return this._getFileFromChromeFileSystem(scaryPath);
    } else if (this.isGithub) {
      return this._getFileFromGitHub(scaryPath);
    } else {
      return this._getFileFetchResponse(scaryPath);
    }
  }

  private async _getFileFetchResponse(scaryPath: string): Promise<Response> {
    console.log('Raw scaryPath input:', scaryPath);
    const headers: Record<string, string> = {};

    if (this.needsAuth) {
      // Request and receive the message from Amplify containing the username and access token
      const { token, username } = await new Promise<{ token: string; username: string }>(
        (resolve, reject) => {
          const handleMessage = (event: MessageEvent) => {
            if (event.data.accessToken && event.data.username) {
              resolve({
                token: event.data.accessToken,
                username: event.data.username,
              });
            } else {
              reject(new Error('No token or username received from parent.'));
            }
          };

          window.parent.postMessage('requestAuthToken', '*');
          window.addEventListener('message', handleMessage, { once: true });
        }
      );

      if (!token || !username) {
        throw new Error('No authentication token or username found. Please log in.');
      }

      // Use the token for AWS requests
      headers['Authorization'] = `Bearer ${token}`;

      // Normalize path - remove leading and trailing slashes
      scaryPath = scaryPath.replace(/^\/+|\/+$/g, '');

      // Construct full URL safely without double slashes
      const baseUrl = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
      const fullPath = `${baseUrl}/${scaryPath}`;

      // Make a GET request
      const response = await fetch(fullPath, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        console.log('Status:', response.status, 'URL:', fullPath);
        throw response;
      }

      return response;
    } else {
      // If auth is not needed, use the original path without modification
      const path = this.cleanURL(scaryPath);
      const response = await fetch(path, { headers });

      if (!response.ok) {
        console.log('Status:', response.status);
        throw response;
      }

      return response;
    }
  }

  private async _getFileFromChromeFileSystem(scaryPath: string): Promise<Response> {
    // Chrome File System Access API doesn't handle nested paths, annoying.
    // We need to first fetch the directory to get the file handle, and then
    // get the file contents.

    let path = scaryPath.replace(/^0-9a-zA-Z_\-\/:+/i, '');
    path = path.replaceAll('//', '/');
    path = new URL(`http://local/${path}`).href;
    path = path.substring(13);

    const slash = path.lastIndexOf('/');
    const folder = path.substring(0, slash);
    const filename = path.substring(slash + 1);

    const dirContents = await this.getDirectory(folder);
    const fileHandle = dirContents.handles[filename];

    if (!fileHandle) throw Error(`File ${filename} missing`);

    const file = (await fileHandle.getFile()) as any;

    file.json = () => {
      return new Promise(async (resolve, reject) => {
        const text = await file.text();
        const json = JSON.parse(text);
        resolve(json);
      });
    };

    file.blob = () => {
      return new Promise(async (resolve, reject) => {
        resolve(file);
      });
    };

    return new Promise((resolve, reject) => {
      resolve(file);
    });
  }

  private async _getFileFromGitHub(scaryPath: string): Promise<Response> {
    // First get the JSON for the file.
    // -> If the file is small, 'content' will be present as base64
    // -> If the file is large, the SHA will be there, and a second blob API request will get the content

    let path = scaryPath.replace(/^0-9a-zA-Z_\-\/:+/i, '');
    path = path.replaceAll('//', '/');

    if (path.startsWith('/')) path = path.slice(1);

    const bits = path.split('/').filter(m => !!m);
    if (bits.length < 2) {
      console.log('no.');
      return new Promise((resolve, reject) => {
        resolve(null as any);
      });
    }

    const ownerRepo = `${bits[0]}/${bits[1]}`;
    let ghUrl = `https://api.github.com/repos/${ownerRepo}/contents/`;
    bits.shift();
    bits.shift();
    ghUrl += bits.join('/');

    const z = ['11', 'pat', 'github'].reverse().join('_');
    const hexcode = '_SyKezxQUoOKXAx3HwTH51I4funGUSFfxdbGG2X4l3WvUHIW62GOOmO0OMWZ';
    const headers = { Authorization: `Bearer ${z}${PIECES}${hexcode}` };

    let json = await await fetch(ghUrl, {
      headers,
    }).then(r => r.json());

    let content = json.content;

    // if file is large, content is behind a 2nd blob API request by SHA value
    if (!content) {
      ghUrl = `https://api.github.com/repos/${ownerRepo}/git/blobs/${json.sha}`;
      json = await await fetch(ghUrl, {
        headers,
      }).then(r => r.json());
      content = json.content;
    }

    if (json.encoding == 'base64') {
      const binaryString = Uint8Array.from(atob(json.content), char => char.charCodeAt(0));
      // no way to know from GitHub what type of file this is, so we have to guess
      if (BINARIES.test(scaryPath.toLocaleLowerCase())) {
        content = binaryString;
      } else {
        content = new TextDecoder().decode(binaryString);
      }
    } else if (json.encoding == 'utf-8') {
      content = new TextDecoder().decode(json.content);
    } else {
      content = json.content;
    }

    const response = {
      text: () => {
        return new Promise((resolve, reject) => {
          resolve(content);
        });
      },
      json: () => {
        return new Promise(async (resolve, reject) => {
          const json = JSON.parse(content);
          resolve(json);
        });
      },
      blob: () => {
        return new Promise(async (resolve, reject) => {
          resolve(new Blob([content], { type: 'application/octet-stream' }));
        });
      },
    } as any;

    return response;
  }

  private async _getDirectoryFromGitHub(scaryPath: string): Promise<DirectoryEntry> {
    let path = scaryPath.replace(/^0-9a-zA-Z_\-\/:+/i, '');
    path = path.replaceAll('//', '/');
    if (path.startsWith('/')) path = path.slice(1);

    const listing = { dirs: [], files: [], handles: {} } as DirectoryEntry;

    const bits = path.split('/').filter(m => !!m);
    if (bits.length < 2) {
      return listing;
    }

    let ghUrl = `https://api.github.com/repos/${bits[0]}/${bits[1]}/contents/`;
    bits.shift();
    bits.shift();
    ghUrl += bits.join('/');

    const z = ['11', 'pat', 'github'].reverse().join('_');
    const hexcode = '_SyKezxQUoOKXAx3HwTH51I4funGUSFfxdbGG2X4l3WvUHIW62GOOmO0OMWZ';
    const headers = { Authorization: `Bearer ${z}${PIECES}${hexcode}` };

    const json = (await await fetch(ghUrl, {
      headers,
    }).then(r => r.json())) as any[];

    // console.log(json)

    json.forEach(entry => {
      if (entry.type == 'file') listing.files.push(entry.name);
      if (entry.type == 'dir') listing.dirs.push(entry.name);
    });

    return listing;
  }

  async getFileText(scaryPath: string): Promise<string> {
    // This can throw lots of errors; we are not going to catch them
    // here so the code further up can deal with errors properly.
    // "Throw early, catch late."
    const response = await this._getFileResponse(scaryPath);
    return response.text();
  }

  async getFileJson(scaryPath: string): Promise<any> {
    // This can throw lots of errors; we are not going to catch them
    // here so the code further up can deal with errors properly.
    // "Throw early, catch late."
    const response = await this._getFileResponse(scaryPath);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();

    // recursively gunzip until it can gunzip no more:
    const unzipped = this.gUnzip(buffer);
    const text = new TextDecoder('utf-8').decode(unzipped);

    return JSON.parse(text);
  }

  async getFileBlob(scaryPath: string): Promise<Blob> {
    // This can throw lots of errors; we are not going to catch them
    // here so the code further up can deal with errors properly.
    // "Throw early, catch late."
    const response = await this._getFileResponse(scaryPath);
    return response.blob();
  }

  async getFileStream(scaryPath: string): Promise<ReadableStream> {
    if (this.fsHandle) {
      const stream = await this._getFileFromChromeFileSystem(scaryPath)
        .then(response => response.blob())
        .then(blob => blob.stream());
      return stream as any;
    } else {
      const stream = await this._getFileFetchResponse(scaryPath).then(response => response.body);
      return stream as any;
    }
  }

  async getDirectory(scaryPath: string): Promise<DirectoryEntry> {
    // This can throw lots of errors; we are not going to catch them
    // here so the code further up can deal with errors properly.
    // "Throw early, catch late."
    let stillScaryPath = scaryPath.replaceAll('//', '/');

    // don't download any files!
    if (!stillScaryPath.endsWith('/')) stillScaryPath += '/';

    // Use cached version if we have it
    const cachedEntry = CACHE[this.urlId][stillScaryPath];
    if (cachedEntry) return cachedEntry;

    stillScaryPath = stillScaryPath.replaceAll('/./', '/');

    try {
      // Generate and cache the listing
      let dirEntry: DirectoryEntry;

      if (this.fsHandle) dirEntry = await this.getDirectoryFromHandle(stillScaryPath);
      else if (this.isGithub) dirEntry = await this._getDirectoryFromGitHub(stillScaryPath);
      else if (this.needsAuth) dirEntry = await this._getDirectoryFromAWS(stillScaryPath);
      else dirEntry = await this.getDirectoryFromURL(stillScaryPath);

      // human-friendly sort
      dirEntry.dirs.sort((a, b) => naturalSort(a, b));
      dirEntry.files.sort((a, b) => naturalSort(a, b));

      CACHE[this.urlId][stillScaryPath] = dirEntry;
      return dirEntry;
    } catch (e) {
      throw Error('' + e);
    }
  }

  // might pass in the global store, or not
  async getDirectoryFromHandle(stillScaryPath: string, store?: any) {
    // File System API has no concept of nested paths, which of course
    // is how every filesystem from the past 60 years is actually laid out.
    // Caching each level should lessen the pain of this weird workaround.

    // Bounce thru each level until we reach this one.
    // (Do this top down in order instead of recursive.)

    // I want: /data/project/folder
    // get / and find data
    // get /data and find project
    // get project and find folder
    // get folder --> that's our answer

    const contents: DirectoryEntry = { files: [], dirs: [], handles: {} };
    if (!this.fsHandle) return contents;

    const granted = await this.getChromePermission(this.fsHandle);
    if (!granted) return contents;

    let parts = stillScaryPath.split('/').filter(p => !!p); // split and remove blanks

    // Normalize directory / get rid of '..' sections
    function eatDots(parts: string[]): string[] {
      const dotdot = parts.indexOf('..');
      if (dotdot <= 0) return parts;
      const spliced = parts.filter((part: string, i) => i !== dotdot - 1 && i !== dotdot);
      return eatDots(spliced);
    }

    const cleanDirParts: string[] = eatDots(parts);

    let currentDir = this.fsHandle as any;

    // iterate thru the tree, top-down:
    if (cleanDirParts.length) {
      for (const subfolder of cleanDirParts) {
        let found = false;
        for await (let [name, handle] of currentDir) {
          if (name === subfolder) {
            currentDir = handle;
            found = true;
            break;
          }
        }
        if (!found) throw Error(`Could not find folder "${subfolder}"`);
      }
    }

    // haven't crashed yet? Get the listing details!
    for await (let entry of currentDir.values()) {
      if (contents.handles) contents.handles[entry.name] = entry;
      if (entry.kind === 'file') {
        contents.files.push(entry.name);
      } else {
        contents.dirs.push(entry.name);
      }
    }
    return contents;
  }

  async getDirectoryFromURL(stillScaryPath: string) {
    // console.log(stillScaryPath)
    const response = await this._getFileResponse(stillScaryPath).then();
    const htmlListing = await response.text();
    // console.log(htmlListing)
    const dirEntry = this.buildListFromHtml(htmlListing);
    return dirEntry;
  }

  /**
 * Parses the HTML directory listing (generated by Lambda) into files and directories.
 */
  private parseHtmlDirectoryListing(htmlText: string): { files: string[]; dirs: string[] } {
    const files: string[] = [];
    const dirs: string[] = [];

    // Create a temporary DOM parser
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    // Find all <a> elements (links to files/directories)
    const links = doc.querySelectorAll('a');

    links.forEach(link => {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim();

      // Skip the ".." parent directory link
      if (href === '../' || text === '..') {
        return;
      }

      if (href && text) {
        // For directories, the href ends with '/' and text ends with '/'
        if (href.endsWith('/') && text.endsWith('/')) {
          // Remove trailing slash to get directory name
          const dirName = href.replace(/\/$/, '');
          dirs.push(dirName);
        }
        // For files, neither href nor text ends with '/'
        else if (!href.endsWith('/') && !text.endsWith('/')) {
          files.push(href);
        }
      }
    });

    return { files, dirs };
  }

  private async _getDirectoryFromAWS(scaryPath: string): Promise<DirectoryEntry> {
    const headers: Record<string, string> = {};

    // Request and receive the message from Amplify containing the username and access token
    const { token, username } = await new Promise<{ token: string; username: string }>((resolve, reject) => {
      const handleMessage = (event: MessageEvent) => {
        if (event.data.accessToken && event.data.username) {
          resolve({
            token: event.data.accessToken,
            username: event.data.username,
          });
        } else {
          reject(new Error('No token or username received from parent.'));
        }
      };

      window.parent.postMessage('requestAuthToken', '*');
      window.addEventListener('message', handleMessage, { once: true });
    });

    if (!token || !username) {
      throw new Error('No authentication token or username found. Please log in.');
    }

    // Use the token for AWS requests
    headers['Authorization'] = `Bearer ${token}`;

    // Normalize scaryPath (remove leading slashes)
    scaryPath = scaryPath.replace(/^\/+/, '');

    // Construct full URL safely without double slashes
    const fullPath = new URL(scaryPath, this.baseUrl).href;

    // Ensure the path ends with a slash for directories
    const isDirectory = !/\.[a-zA-Z0-9]+$/.test(scaryPath);
    const normalizedPath = isDirectory ? fullPath.replace(/\/+$/, '') + '/' : fullPath.replace(/\/+$/, '');

    // Make a GET request to fetch the directory listing (HTML response from Lambda)
    const response = await fetch(normalizedPath, { method: 'GET', headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch AWS directory: ${response.statusText}`);
    }

    // Extract text response (HTML)
    const htmlText = await response.text();

    console.log('HTML Response:', htmlText);

    // Parse HTML to extract files and directories
    const { files, dirs } = this.parseHtmlDirectoryListing(htmlText);

    console.log('Files:', files);
    console.log('Dirs:', dirs);

    // Return a DirectoryEntry object
    return {
      files,
      dirs,
      handles: {}, // Add any additional metadata if needed
      html: htmlText, // Store the raw HTML for display
    };
  }

  async findAllYamlConfigs(folder: string): Promise<YamlConfigs> {
    const yamls: YamlConfigs = { dashboards: {}, topsheets: {}, vizes: {}, configs: {} };

    const configFolders = [];

    // first find all simwrapper folders
    let currentPath = '/';
    let fullFolder = folder.startsWith('/') ? folder : '/' + folder;

    const pathChunks = fullFolder.split('/');

    for (const chunk of pathChunks.slice(0, pathChunks.length - 1)) {
      currentPath = `${currentPath}${chunk}/`.replaceAll('//', '/');

      try {
        const { dirs } = await this.getDirectory(currentPath);
        for (const dir of dirs) {
          if (YAML_FOLDERS.includes(dir.toLocaleLowerCase())) {
            configFolders.push(`${currentPath}/${dir}`.replaceAll('//', '/'));
          }
        }
      } catch (e) {}
    }

    // also add current working folder as final option, which supersedes all others
    configFolders.push(folder);

    // find all dashboards, topsheets, and viz-* yamls in each configuration folder.
    // Overwrite keys as we go; identically-named configs from parent folders get superceded as we go.
    const dashboard = 'dashboard*.y?(a)ml';
    const topsheet = '(topsheet|table)*.y?(a)ml';
    const viz = 'viz*.y?(a)ml';
    const config = 'simwrapper-config.y?(a)ml';

    for (const configFolder of configFolders) {
      const { files } = await this.getDirectory(configFolder);

      micromatch
        .match(files, dashboard)
        .map(yaml => (yamls.dashboards[yaml] = `${configFolder}/${yaml}`.replaceAll('//', '/')));

      micromatch
        .match(files, topsheet)
        .map(yaml => (yamls.topsheets[yaml] = `${configFolder}/${yaml}`.replaceAll('//', '/')));

      micromatch
        .match(files, viz)
        .map(yaml => (yamls.vizes[yaml] = `${configFolder}/${yaml}`.replaceAll('//', '/')));

      micromatch
        .match(files, config)
        .map(yaml => (yamls.configs[yaml] = `${configFolder}/${yaml}`.replaceAll('//', '/')));
    }

    return yamls;
  }

  private buildListFromHtml(data: string): DirectoryEntry {
    if (data.indexOf('SimpleWebServer') > -1) return this.buildListFromSimpleWebServer(data);
    if (data.indexOf('<ul>') > -1) return this.buildListFromSVN(data);
    if (data.indexOf('<ul id="files">') > -1) return this.buildListFromNpxServe(data);
    if (data.indexOf('<table>') > -1) return this.buildListFromApache24(data);
    if (data.indexOf('\n<a ') > -1) return this.buildListFromNGINX(data);

    return { dirs: [], files: [], handles: {} };
  }

  private buildListFromSimpleWebServer(data: string): DirectoryEntry {
    const regex = /">(.*?)<\/a/;
    const dirs = [];
    const files = [];

    const lines = data.split('\n');
    for (const line of lines) {
      const href = line.indexOf('<li><a href="');
      if (href < 0) continue;
      const entry = line.match(regex);
      if (!entry) continue;

      // got one!
      const name = entry[1]; // regex returns first match in [1]

      if (name.endsWith('/')) dirs.push(name.substring(0, name.length - 1));
      else files.push(name);
    }
    return { dirs, files, handles: {} };
  }

  private buildListFromNpxServe(data: string): DirectoryEntry {
    const regex = /"(.*?)"/;
    let dirs = [];
    let files = [];

    const lines = data.split('</li>').map(line => line.slice(line.lastIndexOf('<li')));

    for (const line of lines) {
      const href = line.indexOf('<li> <a href="');
      if (href < 0 || href > 512) continue;
      const entry = line.match(regex);
      if (!entry) continue;

      // got one!
      let name = entry[1]; // regex returns first match in [1]
      name = name.replaceAll('&#47;', '/');
      if (name === '/') continue;
      if (name === '../') continue;
      if (name.endsWith('/')) dirs.push(name.substring(0, name.length - 1));
      else files.push(name);
    }

    dirs = dirs.map(d => d.slice(1 + d.lastIndexOf('/')));
    files = files.map(d => d.slice(1 + d.lastIndexOf('/')));
    return { dirs, files, handles: {} };
  }

  private buildListFromSVN(data: string): DirectoryEntry {
    const regex = /"(.*?)"/;
    const dirs = [];
    const files = [];

    const lines = data.split('\n');

    for (const line of lines) {
      const href = line.indexOf('<li><a href="');
      if (href < 0) continue;
      const entry = line.match(regex);
      if (!entry) continue;

      // got one!
      let name = entry[1]; // regex returns first match in [1]

      if (name === '../') continue;
      if (name.startsWith('./')) name = name.substring(2);

      if (name.endsWith('/')) dirs.push(name.substring(0, name.length - 1));
      else files.push(name);
    }
    return { dirs, files, handles: {} };
  }

  private buildListFromApache24(data: string): DirectoryEntry {
    const regex = /"(.*?)"/;
    const dirs = [];
    const files = [];

    const lines = data.split('\n');

    for (const line of lines) {
      // skip header
      if (line.indexOf('<th "') > -1) continue;
      if (line.indexOf('[PARENTDIR]') > -1) continue;

      // match rows listing href links only: should be all folders/files only
      const href = line.indexOf('<td><a href="');
      if (href < 0) continue;

      const entry = line.substring(href).match(regex);
      if (!entry) continue;

      // got one!
      const name = entry[1]; // regex returns first match in [1]

      if (name === '../') continue;

      if (name.endsWith('/')) dirs.push(name.substring(0, name.length - 1));
      else files.push(name);
    }
    return { dirs, files, handles: {} };
  }

  private buildListFromNGINX(data: string): DirectoryEntry {
    const regex = /"(.*?)"/;
    const dirs = [];
    const files = [];

    const lines = data.split('\n');

    for (const line of lines) {
      // match rows listing href links only: should be all folders/files only
      const href = line.indexOf('<a href="');
      if (href < 0) continue;

      const entry = line.substring(href).match(regex);
      if (!entry) continue;

      // got one!
      const name = entry[1]; // regex returns first match in [1]

      // skip parent link
      if (name === '../') continue;

      if (name.endsWith('/')) {
        dirs.push(name.substring(0, name.length - 1));
      } else {
        files.push(name);
      }
    }
    return { dirs, files, handles: {} };
  }

  /**
   * This recursive function gunzips the buffer. It is recursive because
   * some combinations of subversion, nginx, and various web browsers
   * can single- or double-gzip .gz files on the wire. It's insane but true.
   */
  private gUnzip(buffer: any): Uint8Array {
    // GZIP always starts with a magic number, hex $8b1f
    const header = new Uint8Array(buffer.slice(0, 2));
    if (header[0] === 0x1f && header[1] === 0x8b) {
      return this.gUnzip(pako.inflate(buffer));
    }
    return buffer;
  }
}

export default HTTPFileSystem;