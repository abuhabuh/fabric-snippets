import {AudioGraphStore} from 'static/js/player_app/stores/audio_graph_store';
import {Track} from 'static/js/player_app/model/track';
import {TrackCacheOutOfMemory} from 'static/js/player_app/shared/exception';

import {TrackStore} from 'static/js/player_app/stores/track_store';

/**
 * Track cache. Key is a tracks id field.
 *
 * {
 *   'com.soundcloud~1253': <Track object>,
 *   'com.soundcloud~4859': <Track object>
 *   ...
 * }
 *
 * TODO: TURN THIS into non-static class!
 */
var _cache = {};
// Tracks in memory needs to be around 4 (todo: figure out actual memory
// limitation) on mobile because google chrome will stop and reload a
// background tab that uses too much memory. This happened on the Samsung
// Galaxy Tab Elite with 1GB memory. (cheap $100 tablet)
// todo: track cache loads need to be prioritized. Max memory issues still
//   needs a solution
var MAX_TRACKS = 6;  // hack for tracking cache size for now


/**
 * Track Cache loader singleton constructor - getInstance()
 */
var TrackCache = {};
var tcInstance = null;
TrackCache.getInstance = function() {
  if (!tcInstance) {
    tcInstance = new TrackCacheInst();
  }
  return tcInstance;
};

/*** Actual track cache instance constructor ***/
/**
 * TrackCache instance constructor
 *
 *
 */
var TrackCacheInst = function () {};


/*** PUBLIC prototype functions ***/


/**
 * Adds track object to cache overwriting what's already there. Sets the
 * status to LOADING. Throws exception if cache is full.
 *
 * @param {Object} track, Track object
 * @return {Boolean} true if track added, false otherwise
 */
TrackCacheInst.prototype.addTrackAsLoading = function(track) {
  if (!_checkAndMakeSpace(track.getGuid())) {
    throw new TrackCacheOutOfMemory(
      this, 'addTrackAsLoading',
      'cache full - num tracks loaded or loading: ' + _getNumTracksLoadedOrLoading());
  }

  track.setStatusLoading();

  if (!this.contains(track.getGuid())) {
    _cache[track.getGuid()] = track;
  }

  return true;
};


/**
 * Checks if the cache contains the track object
 *
 * @param {String} trackGuid, Track guid
 * @return {Boolean} true if cache contains track
 */
TrackCacheInst.prototype.contains = function(trackGuid) {
  return trackGuid in _cache;
};


/**
 * @param {String} trackGuid, String for track guid
 *
 * @return {Boolean} True if track was found and removed. False if not found.
 */
TrackCacheInst.prototype._destroy = function(trackGuid) {
  if (this.contains(trackGuid)) {
    delete _cache[trackGuid];
    return true;
  }

  return false;
};


/**
 * Gets track object from cache.
 *
 * @return {Object} Track object or null if not found
 */
TrackCacheInst.prototype.getTrack = function(trackGuid) {
  if (this.contains(trackGuid)) {
    return _cache[trackGuid];
  }
  return null;
};


/*** PRIVATE functions ***/

/**
 * Checks if there is space in the cache for another track and clears space
 * if needed / possible. Tracks that are bound to a channel cannot be freed
 * because the assumption is that they are needed for playback.
 *
 * @param {String} targetTrackGuid, Track guid string for track that we're trying to
 *   make space for.
 * @return {Boolean} true if there's enough space, false if cache full.
 */
var _checkAndMakeSpace = function (targetTrackGuid) {
  var numTracksLoadedOrLoading = _getNumTracksLoadedOrLoading();
  if (numTracksLoadedOrLoading >= MAX_TRACKS) {
    // First check if track we're trying to make memory for is already loaded
    // or is loading. If that's the case, then we don't need space.
    if (typeof(targetTrackGuid) === 'string') {
      let track = _cache[targetTrackGuid];
      if (track && (track.isStatusLoadSuccess() || track.isStatusLoading())) {
        return true;
      }
    }

    // Tracks that are bound to channels are kept in memory because they can
    // be played at any time.
    var trackGuidsInChannels = AudioGraphStore.getTrackGuids();
    var madeRoom = false;

    // For each track in the cache, if it's loaded (taking up memory) and not
    // used in a channel (not being played), then we can deallocate it
    for (let trackGuid in _cache) {
      let track = _cache[trackGuid];
      if (track.isStatusLoadSuccess() &&
          trackGuidsInChannels.indexOf(trackGuid) === -1) {
        let shouldUnloadBuffer = true;
        track.setStatusNotLoaded(shouldUnloadBuffer);
        madeRoom = true;
        break;
      }
    }

    if (madeRoom) {
      return true;
    } else {
      return false;
    }
  }

  return true;
};

/**
 * Count number of loaded and loading tracks.
 *
 * @return {Number} Number of tracks that will take up memory
 */
var _getNumTracksLoadedOrLoading = function () {
  var count = 0;
  for (let trackGuid in _cache) {
    let track = _cache[trackGuid];
    if (track.isStatusLoadSuccess() || track.isStatusLoading()) {
      count ++;
    }
  }

  return count;
};


export {TrackCache};
