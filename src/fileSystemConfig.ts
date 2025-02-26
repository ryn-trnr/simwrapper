import { get, set, clear } from 'idb-keyval';
import { FileSystemConfig, FileSystemAPIHandle } from '@/Globals';
import globalStore from '@/store';

const BASE_URL = import.meta.env.BASE_URL;

// The URL contains the websiteLiveHost, calculated at runtime
let loc = {} as any;
let webLiveHostname = 'NOPE';
let websiteLiveHost = 'NOPE';

if (typeof window !== 'undefined') {
  loc = window.location;
  webLiveHostname = loc?.hostname;
  websiteLiveHost = `${loc?.protocol}//${webLiveHostname}`;
}

// Utility function to fetch the username and token
export async function getAuthTokenAndUsername(): Promise<{ token: string; username: string }> {
  return new Promise<{ token: string; username: string }>((resolve, reject) => {
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
}

// Function to generate the baseURL with the username
async function getS3BaseURL(): Promise<string> {
  try {
    const { username } = await getAuthTokenAndUsername();
    return `https://d3o15hrk68p27o.cloudfront.net/user-scenarios/${username}/`;
  } catch (error) {
    console.error('Failed to fetch username:', error);
    // Fallback to a default baseURL or throw an error
    throw new Error('User is not logged in. Please log in to access the S3 bucket.');
  }
}

export function addInitialLocalFilesystems(
  filesystems: { handle: FileSystemAPIHandle; key: string }[]
) {
  filesystems.forEach((fsystem, i) => {
    const slug = `${fsystem.key}`;
    const fsconfig: FileSystemConfig = {
      name: filesystems[i].handle.name,
      slug: slug,
      description: 'Local folder',
      handle: filesystems[i].handle,
      baseURL: '',
    };
    // place at the front of the list
    fileSystems.unshift(fsconfig);
    globalStore.commit('addLocalFileSystem', { key: fsconfig.slug, handle: fsconfig.handle });
  });
}

export function addLocalFilesystem(handle: FileSystemAPIHandle, key: string | null) {
  let slug = key;
  if (!slug) {
    let max = 0;
    globalStore.state.localFileHandles.forEach(local => {
      const fs = local.key.split('-')[0];
      const num = parseInt(fs.substring(2));
      max = Math.max(max, num);
    });
    slug = `fs${max + 1}-${handle.name}`;
  }

  const system: FileSystemConfig = {
    name: handle.name,
    slug: slug,
    description: 'Local folder',
    handle: handle,
    baseURL: '',
  };

  fileSystems.unshift(system);

  // commit to app state
  globalStore.commit('addLocalFileSystem', { key: system.slug, handle: handle });

  // write it out to indexed-db so we have it on next startup
  const sorted = [...globalStore.state.localFileHandles];
  sorted.sort((a, b) => (a.handle.name < b.handle.name ? -1 : 1));
  set('fs', sorted);
  return system.slug;
}

let fileSystems: FileSystemConfig[] = [
  // DO NOT REMOVE THESE, THEY ARE FOR INTERNAL APP USE
  {
    name: 'github',
    slug: 'github',
    description: 'GitHub repo file access',
    baseURL: '',
    isGithub: true,
    hidden: true,
  },
  {
    name: 'interactive',
    slug: '',
    description: 'Drag and Drop"',
    baseURL: '',
    hidden: true,
  },
  {
    name: webLiveHostname + ' live folders',
    slug: 'live',
    description: 'Files served using "simwrapper here"',
    baseURL: websiteLiveHost + ':8050/_f_', // e.g. 'http://localhost:8050/_f_',
    hidden: true,
  },
  {
    name: 'Public Data Folder',
    slug: 'files',
    description: 'Data from /public/data folder',
    baseURL: loc.origin + BASE_URL + 'data',
    hidden: true,
  },
  {
    name: 'Browse data',
    slug: 'view',
    description: "View this site's datasets",
    baseURL: loc.origin + '/data',
    hidden: true,
  },

  // End. Below here, these are editable:

  {
    name: 'VSP TU-Berlin',
    slug: 'public',
    description: 'Public data at VSP / TU Berlin',
    baseURL: 'https://svn.vsp.tu-berlin.de/repos/public-svn/matsim/scenarios/countries',
    thumbnail: '/simwrapper/images/thumb-chart.jpg',
    skipList: ['episim/battery'],
    hidden: true,
  },
  {
    name: 'Berlin Open Scenario v6.3',
    slug: 'open-berlin',
    description: 'Standard dashboard from the MATSim SimWrapper contrib',
    thumbnail: 'images/thumb-localfiles.jpg',
    baseURL:
      'https://svn.vsp.tu-berlin.de/repos/public-svn/matsim/scenarios/countries/de/berlin/berlin-v6.3/output/berlin-v6.3-10pct/',
    example: true,
    hidden: true,
  },
  {
    name: 'Visualization Examples',
    slug: 'examples',
    description: 'Various SimWrapper data vis types',
    thumbnail: 'images/thumb-localfiles.jpg',
    baseURL: 'https://svn.vsp.tu-berlin.de/repos/public-svn/shared/simwrapper',
    example: true,
    hidden: false,
  },
  {
    name: 'Hamburg RealLabHH',
    slug: 'reallabhh',
    description: 'Hamburg, Germany',
    description_de: 'Hamburg, Deutschland',
    baseURL:
      'https://svn.vsp.tu-berlin.de/repos/public-svn/matsim/scenarios/countries/de/hamburg/hamburg-v2/hamburg-v2.2/viz',
    thumbnail: '/simwrapper/images/thumb-localfiles.jpg',
    example: true,
    hidden: true,
  },
  {
    name: 'Berlin BENE Project',
    slug: 'bene',
    description: 'widescreen, in German',
    baseURL:
      'https://svn.vsp.tu-berlin.de/repos/public-svn/matsim/scenarios/countries/de/berlin/projects/bene/website',
    thumbnail: '/simwrapper/images/thumb-localfiles.jpg',
    hidden: true,
    example: true,
  },
  {
    name: 'Localhost:8000',
    slug: 'local',
    description: 'Files shared using "simwrapper serve"',
    baseURL: 'http://localhost:8000',
    thumbnail: '/simwrapper/images/thumb-localfiles.jpg',
    hidden: true,
  },
  {
    name: 'Uploaded Scenarios',
    slug: 's3',
    description: 'Authenticated access to S3 bucket',
    baseURL: '', // This will be dynamically set below
    needPassword: true,
    hidden: false,
  },
];

// Dynamically set the baseURL for the S3 bucket
(async () => {
  try {
    const s3BaseURL = await getS3BaseURL();
    const s3Config = fileSystems.find(fs => fs.slug === 's3');
    if (s3Config) {
      s3Config.baseURL = s3BaseURL;
    }
  } catch (error) {
    console.error('Failed to set S3 baseURL:', error);
  }
})();

for (let port = 8000; port < 8049; port++) {
  fileSystems.push({
    name: 'Localhost ' + port,
    slug: `${port}`,
    description: 'Localhost ' + port,
    description_de: 'Localhost ' + port,
    baseURL: 'http://localhost:' + port,
    hidden: true,
  });
}

for (let port = 8050; port < 8099; port++) {
  fileSystems.push({
    name: webLiveHostname + port,
    slug: `${port}`,
    description: webLiveHostname + port,
    description_de: webLiveHostname + port,
    baseURL: websiteLiveHost + `:${port}/_f_`, // e.g. 'http://localhost:8050/_f_',
    hidden: true,
  });
}

// merge user shortcuts
try {
  if (typeof localStorage !== 'undefined') {
    const storedShortcuts = localStorage.getItem('projectShortcuts');
    if (storedShortcuts) {
      const shortcuts = JSON.parse(storedShortcuts) as any[];
      const unique = fileSystems.filter(root => !(root.slug in shortcuts));
      fileSystems = [...Object.values(shortcuts), ...unique];
    }
  }
} catch (e) {
  console.error('ERROR MERGING URL SHORTCUTS:', '' + e);
}

export default fileSystems;