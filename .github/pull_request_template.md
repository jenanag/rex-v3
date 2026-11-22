## Summary

## Verification

## DRY review

- [ ] Searched for an existing definition before adding one.
- [ ] Referenced existing schemas with `$ref`.
- [ ] Regenerated affected vendored and generated files from source.
- [ ] Followed ADR 0019 for internal packages and used exact pins.
- [ ] Kept business logic inside its owning service.
- [ ] Kept tools stateless and free of auth, bus access, caches and calls to other services.
- [ ] Bumped the tool's `keyVersion` if its output changed for the same input.
