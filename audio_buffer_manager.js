import _ from 'underscore';
import AWS from 'aws-sdk';

import {assert} from 'static/js/player_app/shared/assert';
import {LogHandler} from 'static/js/player_app/shared/log_handler';
import {Track} from 'static/js/player_app/model/track';
import {TrackCache} from 'static/js/player_app/logic/track_cache';
import {TrackStore} from 'static/js/player_app/stores/track_store';


/*** PRIVATE variables ***/

/*
 * Cache for tracks
 *
 * All tracks in cache should have decoded PCM data and be ready to play
 */
var _trackCache = TrackCache.getInstance();


/*** Class Definitions ***/

/**
 * Track loader singleton constructor - getInstance()
 * TODO: remove singleton instance pattern
 *
 * See AudioBufferManagerInst constructor for params
 */
var AudioBufferManager = {};
var abmInstance = null;
AudioBufferManager.getInstance = function(audioContext) {
  assert(audioContext, 'AudioBufferManager init requires audioContext');

  if (!abmInstance) {
    abmInstance = new AudioBufferManagerInst(audioContext);
  }
  return abmInstance;
};

/*** Actual audio buffer manager instance constructor ***/
/**
 * AudioBufferManager instance constructor
 *
 * @param {Object} AudioContext object
 */
var AudioBufferManagerInst = function (audioContext) {
  this.audioContext = audioContext;
};


/*** PUBLIC prototype methods ***/


/**
 * @param {String} trackGuid, Track guid string
 * @return {Object} Track object or null if not found
 */
AudioBufferManagerInst.prototype.get = function(trackGuid) {
  return _trackCache.getTrack(trackGuid);
};


/**
* Returns if track's data is loaded.
 *
 * @return {Boolean} true if track's audio data is loaded
 */
AudioBufferManagerInst.prototype.isTrackLoaded = function(trackGuid) {
  var track = this.get(trackGuid);

  return track.isStatusLoadSuccess();
};


/**
 * Loads track source into memory so it's ready to play. All tracks are
 * resolved regardless of load status (loading, load failed, etc.) because
 * client logic can access track status through Track object and behave
 * accordingly.
 *
 * Network load attempt call is not attempted for a track if:
 * - track is in cache and already loaded
 * - track is in cache and currently loading, i.e. another network call in
 *   progress
 *
 * Either all tracks are loaded, or no tracks are loaded - uses promise.all()
 * Pretty much a dumb wrapper around pLoadSingleTrack.
 *
 * TODO - not intelligent -- loads entire track as PCM - HUGE.
 *
 * @param {Array} tracksToLoad, Array of Track object instance
 * @param {Boolean} resolveLoadingTracks, True if tracks in loading status
 *   should also be resolved. Defaults to True.
 *
 * @return {Object} Promise, Resolves to same Array of Track objects that
 *   were passed in.
 */
AudioBufferManagerInst.prototype.pLoadTracks = function(
    tracksToLoad, resolveLoadingTracks) {
  if (typeof(resolveLoadingTracks) === 'undefined') {
    resolveLoadingTracks = true;
  }
  var that = this;
  var trackLoadPromises = [];
  var loadingTracks = [];

  for (let track of tracksToLoad) {
    if (!track.isStatusLoading()) {
      if (!track.isStatusLoadSuccess()) {
        LogHandler.addDebugMsg(
          this, 'pLoadTracks', 'track STATUS: ' + track.getLoadStatus() + ': ' + track.getTitle());
      }
      // if track status is loading, we will reject and break the whole load
      // chain so don't try to load tracks that are loading already
      trackLoadPromises.push(this.pLoadSingleTrack(track));
    } else {
      loadingTracks.push(track);
    }
  }

  return new Promise(function(resolve, reject) {
    if (trackLoadPromises.length === 0) {
      if (resolveLoadingTracks) {
        resolve(loadingTracks);
      } else {
        resolve([]);
      }
    } else {
      Promise.all(trackLoadPromises).then(
        function(loadedTracksArr) {
          if (resolveLoadingTracks) {
            resolve(loadedTracksArr.concat(loadingTracks));
          } else {
            resolve(loadedTracksArr);
          }
        },
        function(reason) {
          reject(reason);
        }
      );
    }
  });

};

/**
 * Loads the track from remote stream, decodes into PCM, saves PCM data
 * on track, discards original source audio. Loads ENTIRE audio.
 *
 * If track is already loaded, the promise resolves.
 * If track is in the middle of loading, the promise rejects.
 *
 * For SoundCloud: 2 GET requests (as of sept/2015)
 * - 1st from api.soundcloud.com to get track meta info
 * - 2nd from soundcloud cdn to get actual audio
 *
 * Assumptions: N/A
 *
 * @param {Object} track, Track object
 *
 * @returns {Object} Promise, Resolves to Track object
 */
AudioBufferManagerInst.prototype.pLoadSingleTrack = function(track) {
  var that = this;
  // trackTitle is tmp for debugging
  var trackTitle = TrackStore.getTrackTitle(track.getGuid());

  return new Promise(function(resolve, reject) {
    var cachedTrack = _trackCache.getTrack(track.getGuid());
    var shouldGetTrack = true;

    if (cachedTrack) {
      if (cachedTrack.isStatusLoading()) {
        reject(new Error('Track is already loading: ' + track.getGuid()));
        shouldGetTrack = false;
      }
      if (cachedTrack.isStatusLoadSuccess()) {
        resolve(track);
        shouldGetTrack = false;
      }
    }

    if (shouldGetTrack) {
      try {
        // Mark track as loading and add track to cache if not in cache. Reject
        // if cache is full
        _trackCache.addTrackAsLoading(track);
      } catch (e) {
        reject(e.message);
        return;
      }

      // todo: extract to aws xhr util
      let s3 = new AWS.S3();
      let bucket = GLOBAL_ENV['AWS_BUCKET_USER_TRACKS'];
      let key = track.getAudioSourceKey();
      LogHandler.addDebugMsg(
        that, 'pLoadSingleTrack', 'Created request to: S3://' + bucket + '/' + key);
      s3.getObject(
        {
          Bucket: bucket,
          Key: key
        },
        function (error, data) {
          if (error != null) {
            track.setStatusLoadFailed();
            reject(new Error('Track request error track[' + track.scId + ']: ' + error));
          } else {
            that.audioContext.decodeAudioData( data.Body.buffer,
              function(buffer) {
                LogHandler.addDebugMsg(
                  that, 'pLoadSingleTrack', 'Done fetching and decoding: ' + trackTitle);
                // set audio buffer also sets status as load success
                track.setAudioBuffer(buffer);
                resolve(track);
              },
              function() {
                track.setStatusLoadFailed();
                // TODO: clean this up - reject with an exception from
                // exception.js or a regular string - don't instantiate Error
                reject(new Error('Decoding error track[' + track.getTitle() + ']'));
              }
            );
          }
        }
      );
    }
  });
};


/**
 * Determine if we should try to load the track or not.
 *
 * @return {Boolean} True if we should try to load the track via network call.
 */
AudioBufferManagerInst.prototype.shouldTryLoad = function(trackGuid) {
  if (_trackCache.contains(trackGuid)) {
    let track = _trackCache.getTrack(trackGuid);
    if (track.isStatusLoading() || track.isStatusLoadSuccess()) {
      return false;
    } else {
      return true;
    }
  }

  // doesn't contain track so of course load it. duh. like...omg
  return true;
};


/*** PRIVATE functions ***/


export {AudioBufferManager};
