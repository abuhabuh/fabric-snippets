/**
 * MixerChannel class. Controlls audio source and playback actions as well as
 * any audio effects on the channel.
 *
 * Playback States:
 * - STOPPED
 *   - Initial state
 *   - PLAYING_AND_STOP_SCHEDULED and scheduled time >= current context time
 * - STOPPED_AND_PLAY_SCHEDULED
 *   - _actionPlay()
 * - PLAYING_AND_STOP_SCHEDULED
 *   - actionStop()
 * - PLAYING
 *   - STOPPED_AND_PLAY_SCHEDULED and scheduled time >= current context time
 *
 */
import _ from 'underscore';

import {COMMON_CONST} from 'static/js/player_app/shared/constants';
import {CONTROL_CONST} from 'static/js/player_app/shared/constants';
import {IllegalParam} from 'static/js/player_app/shared/exception';
import {LogHandler} from 'static/js/player_app/shared/log_handler';
import {NumberUtil} from 'static/js/player_app/shared/number_util';
import {TrackAction} from 'static/js/player_app/model/action/track_action';
import {TrackActionsCollection} from
  'static/js/player_app/model/action/track_actions_collection';
import {TrackActionFactory} from
  'static/js/player_app/model/action/track_action_factory';
import {TrackNotLoaded} from 'static/js/player_app/shared/exception';
import {TimeUtil} from 'static/js/player_app/shared/time_util';
import {TypeUtil} from 'static/js/player_app/shared/type_util';

/*** PRIVATE variables ***/
// pitch bend 0.0X by X percent
var PITCH_BEND_FACTOR = 0.05;


class MixerChannel {

  /**
   * @param {Object} track, Track object - assume loaded
   * @param {Object} audioContext, AudioContext object from Web Audio API
   */
  constructor (track, audioContext) {
    // TODO: need to keep this reference? I think there's a reference to context
    // from any audio node
    this.audioContext = audioContext;
    this.track = track;

    // Always create a gain node. This node does not depend on track audio
    // buffer being loaded.
    _createGainNode(this);
    // Try to create the sourcenode if track's audio buffer is loaded.
    // Creating from scratch so don't need to delete old node or add old
    // actions.
    var deleteOldNode = false;
    var addBackOldActions = false;
    _sourceNodeRecreate(this, deleteOldNode, addBackOldActions);

    /*** pitch bend attributes ***/
    this.preBendPitchValue = null;  // value of pitch before bend
    this.isBent = false;

    if (!track.isPlayable()) {
      // TODO - better warning mechanism
      console.log('MixerChannel:constructor - Track [' + track.getGuid() +
        '] is not playable yet but is added to mixer');
    }

    // List of actions that have been set on the sourceNode. If the sourceNode
    // is reset (to support multiple play / stop actions), then we need to
    // re-add all actions that are still in the future
    this.actionsAddedCollection = new TrackActionsCollection();

    /*** attributes for tracking play status  ***/
    this._resetPlayAttributes();
  }
  /**
   * Constructor helper
   */
  _resetPlayAttributes () {
    this._playState = MixerChannel.playStates.STOPPED;
    this.startScheduledTimeMS = COMMON_CONST.INVALID_TIME_VAL;
    this.stopScheduledTimeMS = COMMON_CONST.INVALID_TIME_VAL;
    // Tracks the offset that this track was started at or stopped at. Allows
    // calculation of track offset on the fly.
    this.startedAtOffsetMS = COMMON_CONST.INVALID_TIME_VAL;
    this.stoppedAtOffsetMS = COMMON_CONST.INVALID_TIME_VAL;
  }


  /**
   * @param {Object} action, TrackAction object
   * @param {Number} baseTimeOffsetMS, Base time to add to each action's
   *   actionTime. This is because AudioContext keeps an ever increasing
   *   internal clock for event scheduling. Defaults to 0.
   * @param {Number} mixSetOffsetTimeMS, Number of milliseconds into the mixset
   *   that the actions will start from. Since the actions have actionTimes that
   *   are relative to the start of the mixset, we have to subtract this time
   *   from the actionTimes. Defaults to 0.
   * @param {Number} minTimeMSAbs, Minimum time that action time (with base
   *   offset delta) can have. If action time is earlier than minTime, then
   *   action is not added. Defaults to 0.
   * @return {Boolean} True if action added
   */
  addActionMc (action, baseTimeOffsetMS, mixSetOffsetTimeMS, minTimeMSAbs) {
    // Source node may not have been created with constructor so try to create
    // here
    if (!_ensureSourceNodePresent(this)) {
      // can't add actions without a source node so throw exception
      throw new TrackNotLoaded(
        this, 'addAction', 'Track not loaded - id: ' + this.track.getTitle());
    }

    if (TimeUtil.isBadTime(baseTimeOffsetMS)) {
      baseTimeOffsetMS = 0;
    }
    if (TimeUtil.isBadTime(mixSetOffsetTimeMS)) {
      mixSetOffsetTimeMS = 0;
    }
    if (TimeUtil.isBadTime(minTimeMSAbs)) {
      minTimeMSAbs = 0;
    }
    var actionAdded = false;

    if (this.track.getGuid() === action.getActionTrackGuid()) {
      var actionType = action.getActionType();

      // todo: correct behavior if both 0?
      if (_filterAtTimeNow(this, action.getActionTimeMSAbs()) <
          minTimeMSAbs) {
        // pass because action time is before the playable time slice
        // TODO: log info?
        return actionAdded;
      }

      var actionTimeMSAbs =
        _filterAtTimeNow(this, action.getActionTimeMSAbs()) +
        baseTimeOffsetMS - mixSetOffsetTimeMS;
      switch(actionType) {
        case TrackAction.types.PLAY:
          actionAdded = _actionPlay(
            this, actionTimeMSAbs, action.getActionOffsetMS());
          break;
        case TrackAction.types.STOP:
          actionAdded = _actionStop(this, actionTimeMSAbs);
          break;
        case TrackAction.types.PAUSE:
          actionAdded = _actionPause(this, actionTimeMSAbs);
          break;
        case TrackAction.types.PITCH:
          actionAdded = _actionPitch(
            this, actionTimeMSAbs, action.getPitchValueApplied());
          break;
        case TrackAction.types.GAIN_FADE:
          actionAdded = _actionGainFade(
            this, actionTimeMSAbs, action.getEndVal(),
            action.getFadeNumBeats(), this.track.getBpm());
          break;
        default:
          LogHandler.addLogSystemError(
            this, 'addAction', 'unmatched action type: ' + actionType);
          break;
      }

      // If action was added to source node, then append it to the list of
      // added actions because source node might get recreated
      if (actionAdded &&
          action.getActionTarget() === TrackAction.targets.SOURCE) {
        let actionCopy = TrackActionFactory.copyFromTrackAction(action);
        this.actionsAddedCollection.addActionWithTimeMSAbs(
          actionCopy, actionTimeMSAbs);
      }
    } else {
      LogHandler.addLogSystemError(
        this, 'addAction',
        'action track guid does not match - trackGuid: ' +
        action.getActionTrackGuid());
    }

    return actionAdded;
  }


  /**
   * @param {Array} actionList, Array of TrackAction objects
   * See addActionMc() for other param details
   *
   * @return {Boolean} True if all actions in actionList were added
   */
  addActions (
      actionList, baseTimeOffsetMS, mixSetOffsetTimeMS, minTimeMSAbs) {
    var allAdded = true;

    for (var action of actionList) {
      allAdded = allAdded && this.addActionMc(
        action, baseTimeOffsetMS, mixSetOffsetTimeMS, minTimeMSAbs);
    }

    return allAdded;
  }


  /**
   * Does the following:
   * - Clear scheduled actions on all nodes where possible (sourceNode cannot
   *   be cleared if audio is playing).
   * - Clears actionsAddedCollection.
   * - Sets channel state to "true" STOPPED
   * - Reset playback attributes to defaults as if channel was just
   *   constructed
   *
   * Actions on Nodes:
   * - GainNode: we can just call resetActions()
   * - SourceNode: we cannot reset a scheduled start() / stop() action so we
   *   need to recreate it.
   *   - If source is currently playing, we cannot reschedule the sourceNode
   *   - If source is stopped, we can reschedule the sourceNode
   *
   * @param {Boolean} forceSourceNodeReset, If true, source node is forced to reset even
   *   if tracks are playing. Defaults to false.
   * @param {Boolean} forceGainNodeReset, Gain node is not auto reset right now because long running
   *   gain fade actions get reset - need to fix this
   */
  clearActions (forceSourceNodeReset, forceGainNodeReset) {
    forceSourceNodeReset = TypeUtil.defaultVal(forceSourceNodeReset, false);
    forceGainNodeReset = TypeUtil.defaultVal(forceGainNodeReset, false);
    // clearing actionsAddedCollection
    this.actionsAddedCollection.resetActions([]);

    // todo: fix this (should just reset each time) -- disabling temporarily because of long running gain ramp
    // actions that will be cancelled. need to find better model of this clear gain node params
    // (audioContext.currentTime is in seconds)
    if (forceGainNodeReset) {
      // todo: this is a hack - see if we can do something lighter weight than recreating gainnode
      this.gainNode.disconnect();
      _createGainNode(this);
      this.sourceNode.connect(this.gainNode);

      // this.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
      // this.gainNode.gain.value = 1;
    }

    var currentPlayState = _getPlayState(this);
    /**
     * Handle the case where the audio source is stopped. Since music is not
     * playing, we can clear the actions from the sourceNode without affecting
     * user experience. We also want to set the channel state to true STOPPED
     * instead of a substate of STOPPED (e.g. STOPPED_AND_PLAY_SCHEDULED)
     */
    if (currentPlayState === MixerChannel.playStates.STOPPED ||
        currentPlayState === MixerChannel.playStates.STOPPED_AND_PLAY_SCHEDULED ||
        forceSourceNodeReset) {
      this._playState = MixerChannel.playStates.STOPPED;
      // reset source node to a clean new one with no actions
      let deleteOldNode = true;
      let addBackOldActions = false;
      _sourceNodeRecreate(this, deleteOldNode, addBackOldActions);
      this._resetPlayAttributes();
    }
  }


  /**
   * Unallocate all graph resources and clean up anything else.
   *
   * TODO: Only disconnecting for now. Need to clean anything up?
   */
  destroy () {
    if (this.sourceNode !== null) {
      this.sourceNode.disconnect();
    }
    if (this.gainNode !== null) {
      this.gainNode.disconnect();
    }
  }


  /**
   * Returns channel title (composed of track name)
   *
   * @return {String} Title of channel
   */
  getChannelTitle () {
    return this.track.getTitle();
  }


  /**
   * @return {Number} Current pitch
   */
  getPitch () {
    return this.sourceNode.playbackRate.value;
  }


  /**
   * @return {Object} Track object
   */
  getTrack () {
    return this.track;
  }


  /**
   *
   * @return {Number} Offset into current track or COMMON_CONST.INVALID_VAL if
   *   track hasn't been played yet.
   */
  getTrackCurrentOffsetMS () {
    var currentPlayState = _getPlayState(this);

    // if state is stopped, it could never have started before so return invalid
    // value as offset
    switch (currentPlayState) {
      case MixerChannel.playStates.STOPPED:
        // fall through
      case MixerChannel.playStates.STOPPED_AND_PLAY_SCHEDULED:
        if (this.stoppedAtOffsetMS === COMMON_CONST.INVALID_TIME_VAL) {
          // no play action scheduled on channel yet, so no offset applicable
          return COMMON_CONST.INVALID_VAL;
        }
        return this.stoppedAtOffsetMS;
      case MixerChannel.playStates.PLAYING:
        // fall through
      case MixerChannel.playStates.PLAYING_AND_STOP_SCHEDULED:
        var currentTimeMS = TimeUtil.secToMS(this.audioContext.currentTime);
        var playedTimeMS = currentTimeMS - this.startScheduledTimeMS;
        return this.startedAtOffsetMS + playedTimeMS;
      default:
        LogHandler.addLogSystemError(
          this, 'getTrackCurrentOffsetMS', 'Invalid state match - current state: ' + currentPlayState);
        return COMMON_CONST.INVALID_VAL;
    }
  }


  /**
   * Bends pitch by PITCH_BEND_FACTOR immediately. Pitch is reset to original
   * value upon calling pitchBendRestore()
   *
   * TODO: a temporary pitch action should be created and piped through
   *   addAction
   *
   * @param {Object} direction, MixerChannel.constants type - which way to do
   *   pitch bend
   * @return {Boolean} True if pitch bent successfully
   */
  pitchBend (direction) {
    // Source node may not have been created with constructor so try to create
    // here
    if (!_ensureSourceNodePresent(this)) {
      // can't add actions without a source node so throw exception
      throw new TrackNotLoaded(
        this, 'addAction', 'Track not loaded - id: ' + this.track.getTitle());
    }

    if (this.isBent) {
      return false;
    }
    var currentPitch = this.sourceNode.playbackRate.value;

    // set positive or negative pitch bend
    var newPitch = currentPitch + PITCH_BEND_FACTOR;
    if (direction === MixerChannel.constants.PITCH_BEND_DOWN) {
      newPitch = currentPitch - PITCH_BEND_FACTOR;
    }

    // save the current value
    this.preBendPitchValue = this.sourceNode.playbackRate.value;
    // set the new value
    this.sourceNode.playbackRate.setValueAtTime(newPitch, this.audioContext.currentTime);

    this.isBent = true;

    return true;
  }


  /**
   * Restore the bent pitch value to what it was before. If the pitch has
   * changed due to some scheduled param event, then don't restore to the
   * old value.
   *
   * BUG: If during pitch bend, a pitch param event sets the pitch to the same
   * value as pitch bend, the restore call will undo that action and the mix
   * will be out of sync. This is because a scheduled param event has no way of
   * notifying the client app.
   *
   * TODO: a temporary pitch action should be created and piped through
   *   addAction
   *
   * @return {Boolean} True if pitch restored. False if old value not restored;
   *   this happens when a scheduled event updates the pitch to another value.
   */
  pitchBendRestore () {
    // Source node may not have been created with constructor so try to create
    // here
    if (!_ensureSourceNodePresent(this)) {
      // can't add actions without a source node so throw exception
      throw new TrackNotLoaded(
        this, 'addAction', 'Track not loaded - id: ' + this.track.getTitle());
    }

    if (!this.isBent || this.preBendPitchValue === null) {
      return;
    }

    this.sourceNode.playbackRate.setValueAtTime(this.preBendPitchValue, this.audioContext.currentTime);
    this.isBent = false;
  }

}

/*** Private mixer channel functions ***/

/**
 * Registers a fade action with the context.
 *
 * Fade uses a linear ramp
 *
 * @param {Object} mc, MixerChannel instance
 * @param {Number} atTimeMS, Time (relative to AudioContext time) to perform
 *   action at
 * @param {Number} endGainVal, Gain value (float) that the fade should obtain
 * @param {Number} fadeNumBeats, Number of beats to fade for
 * @param {Number} trackBpm, bpm for track
 * @return {Boolean} True if action added successfully
 */
var _actionGainFade = function(mc, atTimeMS, endGainVal, fadeNumBeats, trackBpm) {
  // todo: Need to determine what the gain will be during atTimeMS. There could be
  // other gain change that have affected the gain by then.
  if (!NumberUtil.isPositive(trackBpm)) {
    throw new IllegalParam(mc, '_actionGainFade', 'trackBpm not number: ' + trackBpm);
  }
  var fadeTimeSec = (fadeNumBeats / trackBpm) * 60;
  var atTimeSec = atTimeMS / 1000;

  // todo: hack - should take the gain val that track is at
  var initialGainVal = 1 - endGainVal;

  // 1. Call linearRampToValueAtTime once to set the start time at a specific time
  mc.gainNode.gain.linearRampToValueAtTime(initialGainVal, atTimeSec);
  // 2. Call it again to schedule gain change
  mc.gainNode.gain.linearRampToValueAtTime(endGainVal, atTimeSec + fadeTimeSec);
};


/**
 * Registers a play action with the context.
 *
 * @param {Object} mc, MixerChannel instance
 * @param {Number} atTimeMS, Time (relative to AudioContext time) to perform
 *   action at
 * @param {Number} offsetMS, Offset into the track to begin playing from.
 *   Spec'd in milliseconds. Defaults to 0.
 * @return {Boolean} True if action added successfully
 */
var _actionPlay = function(mc, atTimeMS, offsetMS) {
  var actionAdded = false;

  if (TimeUtil.isBadTime(atTimeMS)) {
    LogHandler.addLogSystemError(mc, '_actionPlay', 'invalid param so no-op - atTimeMS: ' + atTimeMS);
    return actionAdded;
  }
  if (TimeUtil.isBadTime(offsetMS)) {
    offsetMS = 0;
  }

  var currentTimeMS = TimeUtil.secToMS(mc.audioContext.currentTime);
  atTimeMS = _filterAtTimeNow(mc, atTimeMS);

  /*** passed basic validation so do play action ***/
  var currentPlayState = _getPlayState(mc);

  switch (currentPlayState) {
    case MixerChannel.playStates.PLAYING:
      if (atTimeMS === currentTimeMS) {
        return actionAdded;
      }
      // TODO: schedule future sourcenode recreate and play action set
      //   _sourceNodeRecreate(mc);

      // Commented out while this is not implemented.
      // LogHandler.addLogSystemError(
      //   mc, '_actionPlay', 'state not implemented: ' + currentPlayState);
      break;
    case MixerChannel.playStates.PLAYING_AND_STOP_SCHEDULED:
      if (atTimeMS === currentTimeMS) {
        return actionAdded;
      }
      // TODO: schedule future sourcenode recreate and play action set
      //   _sourceNodeRecreate(mc);
      LogHandler.addLogSystemError(
        mc, '_actionPlay', 'state not implemented: ' + currentPlayState);
      break;
    case MixerChannel.playStates.STOPPED:
      // recreate the source node in case it's an old one with an existing
      // play action
      _actionPlayHelper(mc, atTimeMS, offsetMS);
      actionAdded = true;
      break;
    case MixerChannel.playStates.STOPPED_AND_PLAY_SCHEDULED:
      if (atTimeMS === currentTimeMS) {
        return actionAdded;
      }
      // TODO: schedule future sourcenode recreate and play action set
      //   _sourceNodeRecreate();
      LogHandler.addLogSystemError(
        mc, '_actionPlay', 'state not implemented: ' + currentPlayState);
      break;
    default:
      LogHandler.addLogSystemError(
        mc, '_actionPlay', 'invalid state: ' + currentPlayState);
      break;
  }

  return actionAdded;
};

/**
 * @param {Object} mc, MixerChannel instance
 */
var _actionPlayHelper = function(mc, atTimeMS, offsetMS) {
  // todo: temporary hack to catch exception when adding > 1 play action to
  // sourcenode
  try {
    mc.sourceNode.start(
      TimeUtil.msToSec(atTimeMS), TimeUtil.msToSec(offsetMS));
  } catch (e) {
    if (e instanceof DOMException) {
      console.log('handle this error: ' + e);
    } else {
      throw e;
    }
  }
  mc.sourceNode.onended = _processPlaybackEnded.bind(null, mc);

  mc.startScheduledTimeMS = atTimeMS;
  mc._playState = MixerChannel.playStates.STOPPED_AND_PLAY_SCHEDULED;

  mc.startedAtOffsetMS = offsetMS;
};


/**
 *
 * @param {Object} mc, MixerChannel instance
 * @param {Number} atTimeMS, Time (relative to AudioContext time) to perform
 *   action at
 * @return {Boolean} True if action added successfully
 */
var _actionPause = function(mc, atTimeMS) {
  var actionAdded = false;
  // TODO - implement - there is no pause

  return actionAdded;
};


/**
 *
 * @param {Object} mc, MixerChannel instance
 * @param {Number} atTimeMS, Time (relative to AudioContext time) to perform
 *   action at. 'undefined', null, or 0 will set the pitch immediately.
 * @param {Number} pitchValue, Value to change the pitch by (e.g. 1.3)
 * @return {Boolean} True if action added successfully
 */
var _actionPitch = function(mc, atTimeMS, pitchValue) {
  var actionAdded = false;

  if (TimeUtil.isBadTime(atTimeMS)) {
    // TODO: log app error
    return actionAdded;
  }

  atTimeMS = _filterAtTimeNow(mc, atTimeMS);

  mc.sourceNode.playbackRate.setValueAtTime(pitchValue, TimeUtil.msToSec(atTimeMS));

  actionAdded = true;
  // if pitch is bent, then clear the bent flag because we just overwrote the value
  mc.isBent = false;

  return actionAdded;
};


/**
 *
 * @param {Object} mc, MixerChannel instance
 * @param {Number} atTimeMS, Time (relative to AudioContext time) to perform
 *   action at
 * @return {Boolean} True if action added successfully
 */
var _actionStop = function(mc, atTimeMS) {
  var actionAdded = false;

  if (TimeUtil.isBadTime(atTimeMS)) {
    // TODO: log app error
    console.log('MixerChannel:_actionStop - atTimeMS not set: ' + atTimeMS);
    return actionAdded;
  }

  atTimeMS = _filterAtTimeNow(mc, atTimeMS);

  /*** passed basic validation so do play action ***/
  var currentPlayState = _getPlayState(mc);

  switch (currentPlayState) {
    case MixerChannel.playStates.PLAYING:
      _actionStopHelper(mc, atTimeMS);
      actionAdded = true;
      break;
    case MixerChannel.playStates.PLAYING_AND_STOP_SCHEDULED:
      // TODO: schedule future sourcenode recreate and play action set
      //   _sourceNodeRecreate(mc);
      LogHandler.addLogSystemError(
        mc, '_actionStop', 'state not implemented: ' + currentPlayState);
      break;
    case MixerChannel.playStates.STOPPED:
      // TODO: schedule future sourcenode recreate and play action set
      //   _sourceNodeRecreate(mc);

      // // commented out while this is not implemented
      // LogHandler.addLogSystemError(
      //   mc, '_actionStop', 'state not implemented: ' + currentPlayState);
      break;
    case MixerChannel.playStates.STOPPED_AND_PLAY_SCHEDULED:
      // TODO: schedule future sourcenode recreate and play action set
      //   _sourceNodeRecreate(mc);
      LogHandler.addLogSystemError(
        mc, '_actionStop', 'state not implemented: ' + currentPlayState);
      break;
    default:
      break;
  }

  return actionAdded;
};


/**
 * @param {Object} mc, MixerChannel instance
 */
var _actionStopHelper = function(mc, atTimeMS) {
  mc.sourceNode.stop(TimeUtil.msToSec(atTimeMS));

  mc.stopScheduledTimeMS = atTimeMS;
  mc._playState = MixerChannel.playStates.PLAYING_AND_STOP_SCHEDULED;

  // before we set other variables to stopped, get the offset that we're
  // stopping at and remember it
  var currentTimeMS = TimeUtil.secToMS(mc.audioContext.currentTime);
  mc.stoppedAtOffsetMS = mc.getTrackCurrentOffsetMS() + atTimeMS -
    currentTimeMS;
};


/**
 * @param {Object} mc, MixerChannel instance
 * @return {Boolean} True if gain node created
 */
var _createGainNode = function(mc) {
  mc.gainNode = mc.audioContext.createGain();
  mc.gainNode.connect(mc.audioContext.destination);
  mc.gainNode.gain.value = 1;
  return true;
};


/**
 * Ensures source node is present by trying to create it. Wrapper around
 * _sourceNodeRecreate
 *
 * @param {Object} mc, MixerChannel instance
 * @return {Boolean} True if source node is present or created, false
 *   otherwise
 */
var _ensureSourceNodePresent = function(mc) {
  var deleteOldNode = false;
  var addBackOldActions = false;
  return _sourceNodeRecreate(mc, deleteOldNode, addBackOldActions);
};


/**
 * Checks if the time param is AT_TIME_NOW and if it is, then return the
 * current context time.
 *
 * @param {Object} mc, MixerChannel instance
 * @param {Number} timeMS, Time in milliseconds or AT_TIME_NOW
 * @return {Number} Time in milliseconds
 */
var _filterAtTimeNow = function(mc, timeMS) {
  var currentTimeMS = TimeUtil.secToMS(mc.audioContext.currentTime);
  if (timeMS === MixerChannel.constants.AT_TIME_NOW) {
    // schedule right away
    timeMS = currentTimeMS;
  }
  return timeMS;
};


/**
 * Return the play state of the channel.
 *
 * @param {Object} mc, MixerChannel instance
 * @return {Object} MixerChannel.playStates type, or null on error
 */
var _getPlayState = function(mc) {
  var currentTimeMS = TimeUtil.secToMS(mc.audioContext.currentTime);

  // If play or stop was scheduled, we need to check if we've transitioned
  // to that state already. Event hooks for web audio not available right now
  // so using context time.
  if (mc._playState === MixerChannel.playStates.STOPPED_AND_PLAY_SCHEDULED) {
    if (currentTimeMS >= mc.startScheduledTimeMS) {
      mc._playState = MixerChannel.playStates.PLAYING;
    }
  } else if (mc._playStates ===
      MixerChannel.playStates.PLAYING_AND_STOP_SCHEDULED) {
    if (currentTimeMS >= mc.stopScheduledTimeMS) {
      mc._playState = MixerChannel.playStates.STOPPED;
    }
  }

  return mc._playState;
};


/**
 * Set the playstate to stopped when playback has finished. Need to do this
 * due to the specific way that WebAudio signals play ended events.
 *
 * @param {Object} mc, MixerChannel instance
 */
var _processPlaybackEnded = function(mc) {
  mc._playState = MixerChannel.playStates.STOPPED;

  // Recreate the source node. We've reached the end or stop action of the
  // current node so no additional play or stop actions can be added to it. So
  // it's useless now. Don't need to add back any existing actions on source
  // node either.
  var deleteOldNode = true;
  var addBackOldActions = false;
  _sourceNodeRecreate(mc, deleteOldNode, addBackOldActions);
};


/**
 * Recreate the source node (or just create it if it does not exist). Also
 * carries over previous source node actions as needed.
 *
 * Assumption - gain node is present
 * NOTE: not tested completely - need to make sure that previous actions are
 * added back as necessary.
 *
 * @param {Object} mc, MixerChannel instance
 * @param {Boolean} deleteOldNode, True if old node should be deleted when
 *   encountered. Defaults to false.
 * @param {Boolean} addBackOldActions, True if actions that were
 *   on the old sourceNode should be added to new sourceNode. Defaults to
 *   false
 * @return {Boolean} True if source node is successfully created or present
 *   already.
 */
var _sourceNodeRecreate = function(mc, deleteOldNode, addBackOldActions) {
  if (!mc.gainNode) {
    return false;
  }
  if (typeof(deleteOldNode) !== 'boolean') {
    deleteOldNode = false;
  }
  if (typeof(addBackOldActions) !== 'boolean') {
    addBackOldActions = false;
  }
  if (!deleteOldNode) {
    // If we're not creating a new source node from an old source node, then
    // there's no old actions to add back
    addBackOldActions = false;
  }

  var createStatusText = '  > executing _sourceNodeRecreate';
  if (mc.sourceNode) {
    if (deleteOldNode) {
      mc.sourceNode.disconnect();
    } else {
      createStatusText = '  > source already present - not creating';
      return true;
    }
  }

  var trackBuffer = mc.track.getAudioBuffer();
  if (trackBuffer) {
    var sourceNode = mc.audioContext.createBufferSource();
    sourceNode.buffer = trackBuffer;
    sourceNode.connect(mc.gainNode);
    mc.sourceNode = sourceNode;
  } else {
    // if track has no audio data loaded, then we cannot create the source
    // node
    mc.sourceNode = null;
    return false;
  }

  // Try reset all actions that were on the old sourceNode onto the new source
  // node
  if (addBackOldActions) {
    var baseTimeOffsetMS = null;
    var mixSetOffsetTimeMS = null;
    var minTimeMSAbs = TimeUtil.secToMS(mc.audioContext.currentTime);
    var actions = mc.actionsAddedCollection.actions;
    // Make copy of actions and empty the actionsAddedCollection
    var tmpActions = [];
    for (let action of actions) {
      tmpActions.push(TrackActionFactory.copyFromTrackAction(action));
    }
    mc.actionsAddedCollection.resetActions([]);
    // Re-insert actions that are in the future relative to current time
    for (let action of tmpActions) {
      if (action.getActionTimeMSAbs() >= minTimeMSAbs) {
        mc.addActionMc(
          action, baseTimeOffsetMS, mixSetOffsetTimeMS, minTimeMSAbs);
      }
    }
  } else {
    mc.actionsAddedCollection = new TrackActionsCollection();
  }

  return true;
};


/*** Constants ***/
MixerChannel.constants = {};
Object.defineProperties(MixerChannel.constants, {
  PITCH_BEND_UP: {value: 'pb_up', writable: false},
  PITCH_BEND_DOWN: {value: 'pb_down', writable: false},
  // AT_TIME_NOW is -1 to force set param value at time to set the param
  // immediately
  AT_TIME_NOW: {value: -1, writable: false}
});

MixerChannel.playStates = {};
Object.defineProperties(MixerChannel.playStates, {
  STOPPED: {value: 'stopped', writable: false},
  STOPPED_AND_PLAY_SCHEDULED: {value: 'play-scheduled', writable: false},
  PLAYING_AND_STOP_SCHEDULED: {value: 'stop-scheduled', writable: false},
  PLAYING: {value: 'playing', writable: false}
});


export {MixerChannel};
