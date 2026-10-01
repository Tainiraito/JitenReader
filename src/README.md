# Notes for Reviewers

## Building

**Environment:**

```
OS: Windows 11  
Node: 22.13.1  
npm: 10.9.2
```

**Build steps:**

```sh
# Install dependencies
npm i

# Build the production Firefox version of the extension to packages/jiten.reader-firefox.xpi
npm run pack firefox
```

## Personal parse-cache branch

The personal/parse-cache branch adds paragraph-level parsing cache with browser-session persistence, 30-minute expiry, bounded LRU eviction, concurrent request deduplication, and invalidation for vocabulary changes. Run npm run test:parse-cache to validate the cache. See the root README for installation, limits, and the known upstream typecheck failures.
