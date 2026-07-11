/**
 * Link Lens — shared/storage.js
 * chrome.storage.local helpers: per-origin index cache (24h TTL) and
 * bulk-run state. Usable from content scripts, popup and background.
 */
(function (ns) {
  'use strict';
  if (ns.storage) return; // idempotent re-injection guard

  var INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  function indexKey(origin) { return 'll_index:' + origin; }
  function bulkKey(origin) { return 'll_bulk:' + origin; }

  function get(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(key, function (obj) {
        resolve(obj ? obj[key] : undefined);
      });
    });
  }

  function set(key, value) {
    return new Promise(function (resolve) {
      var obj = {};
      obj[key] = value;
      chrome.storage.local.set(obj, resolve);
    });
  }

  function remove(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.remove(key, resolve);
    });
  }

  /**
   * Returns the cached index for an origin, or null when absent/expired.
   * Shape: { origin, builtAt, source, shallow, skippedGz, targets: [...] }
   */
  function getIndex(origin) {
    return get(indexKey(origin)).then(function (entry) {
      if (!entry || !entry.builtAt) return null;
      if (Date.now() - entry.builtAt > INDEX_TTL_MS) return null;
      return entry;
    });
  }

  function setIndex(origin, index) {
    index.builtAt = Date.now();
    index.origin = origin;
    return set(indexKey(origin), index);
  }

  function clearIndex(origin) {
    return remove(indexKey(origin));
  }

  /** Bulk-run state so the popup can close/reopen mid-batch. */
  function getBulkState(origin) {
    return get(bulkKey(origin)).then(function (v) { return v || null; });
  }

  function setBulkState(origin, state) {
    state.updatedAt = Date.now();
    return set(bulkKey(origin), state);
  }

  ns.storage = {
    INDEX_TTL_MS: INDEX_TTL_MS,
    getIndex: getIndex,
    setIndex: setIndex,
    clearIndex: clearIndex,
    getBulkState: getBulkState,
    setBulkState: setBulkState
  };
})(self.__linkLens = self.__linkLens || {});
