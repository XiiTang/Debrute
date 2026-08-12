import { describe, expect, it } from 'vitest';
import { recentProjectPresentation } from './recentProjectPresentation';

describe('recentProjectPresentation', () => {
  it('uses the macOS user-home label while preserving the Project basename', () => {
    expect(recentProjectPresentation({
      platform: 'darwin',
      projectRoot: '/Users/tester/Projects/Acme',
      userHome: '/Users/tester'
    })).toEqual({
      projectRoot: '/Users/tester/Projects/Acme',
      name: 'Acme',
      parentPath: '~/Projects',
      compactParentPath: '~/Projects'
    });
  });

  it('preserves the path root and nearest parent in the compact macOS label', () => {
    expect(recentProjectPresentation({
      platform: 'darwin',
      projectRoot: '/Users/tester/Clients/Acme/Website',
      userHome: '/Users/tester'
    })).toEqual({
      projectRoot: '/Users/tester/Clients/Acme/Website',
      name: 'Website',
      parentPath: '~/Clients/Acme',
      compactParentPath: '~/…/Acme'
    });

    expect(recentProjectPresentation({
      platform: 'darwin',
      projectRoot: '/Volumes/Archive/Acme/Website',
      userHome: '/Users/tester'
    }).compactParentPath).toBe('/…/Acme');
  });

  it('preserves POSIX filename characters and case when matching the user home', () => {
    expect(recentProjectPresentation({
      platform: 'darwin',
      projectRoot: '/Users/tester/Projects/Acme\\Archive/Website',
      userHome: '/Users/tester'
    })).toMatchObject({
      parentPath: '~/Projects/Acme\\Archive',
      compactParentPath: '~/…/Acme\\Archive'
    });

    expect(recentProjectPresentation({
      platform: 'darwin',
      projectRoot: '/Users/tester/Projects/Website',
      userHome: '/Users/Tester'
    })).toMatchObject({
      parentPath: '/Users/tester/Projects',
      compactParentPath: '/…/Projects'
    });
  });

  it('keeps Windows drive and UNC roots instead of using a home label', () => {
    expect(recentProjectPresentation({
      platform: 'win32',
      projectRoot: '\\\\?\\C:\\Users\\tester\\Clients\\Acme\\Website',
      userHome: 'C:\\Users\\tester'
    })).toEqual({
      projectRoot: '\\\\?\\C:\\Users\\tester\\Clients\\Acme\\Website',
      name: 'Website',
      parentPath: 'C:\\Users\\tester\\Clients\\Acme',
      compactParentPath: 'C:\\…\\Acme'
    });

    expect(recentProjectPresentation({
      platform: 'win32',
      projectRoot: '\\\\?\\UNC\\server\\share\\Clients\\Acme\\Website',
      userHome: 'C:\\Users\\tester'
    }).compactParentPath).toBe('\\\\server\\share\\…\\Acme');
  });

  it('renders filesystem roots without a repeated parent path', () => {
    expect(recentProjectPresentation({
      platform: 'darwin',
      projectRoot: '/',
      userHome: '/Users/tester'
    })).toEqual({
      projectRoot: '/',
      name: '/',
      parentPath: '',
      compactParentPath: ''
    });
    expect(recentProjectPresentation({
      platform: 'win32',
      projectRoot: 'C:\\',
      userHome: 'C:\\Users\\tester'
    })).toEqual({
      projectRoot: 'C:\\',
      name: 'C:\\',
      parentPath: '',
      compactParentPath: ''
    });
  });
});
