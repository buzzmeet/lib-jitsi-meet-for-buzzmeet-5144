import { getLogger } from 'jitsi-meet-logger';
import transform from 'sdp-transform';

import * as MediaType from '../../service/RTC/MediaType';
import RTCEvents from '../../service/RTC/RTCEvents';
import { VideoType } from '../../service/RTC/VideoType';
import browser from '../browser';
import FeatureFlags from '../flags/FeatureFlags';

const logger = getLogger(__filename);
const SIM_LAYER_1_RID = '1';
const SIM_LAYER_2_RID = '2';
const SIM_LAYER_3_RID = '3';

export const SIM_LAYER_RIDS = [ SIM_LAYER_1_RID, SIM_LAYER_2_RID, SIM_LAYER_3_RID ];

/**
 * Handles track related operations on TraceablePeerConnection when browser is
 * running in unified plan mode.
 */
export class TPCUtils {
    /**
     * Creates a new instance for a given TraceablePeerConnection
     *
     * @param peerconnection - the tpc instance for which we have utility functions.
     * @param videoBitrates - the bitrates to be configured on the video senders for
     * different resolutions both in unicast and simulcast mode.
     */
    constructor(peerconnection, videoBitrates) {
        this.pc = peerconnection;
        this.videoBitrates = videoBitrates;

        /**
         * The startup configuration for the stream encodings that are applicable to
         * the video stream when a new sender is created on the peerconnection. The initial
         * config takes into account the differences in browser's simulcast implementation.
         *
         * Encoding parameters:
         * active - determine the on/off state of a particular encoding.
         * maxBitrate - max. bitrate value to be applied to that particular encoding
         *  based on the encoding's resolution and config.js videoQuality settings if applicable.
         * rid - Rtp Stream ID that is configured for a particular simulcast stream.
         * scaleResolutionDownBy - the factor by which the encoding is scaled down from the
         *  original resolution of the captured video.
         */
        this.localStreamEncodingsConfig = [
            {
                active: true,
                maxBitrate: browser.isFirefox() ? this.videoBitrates.high : this.videoBitrates.low,
                rid: SIM_LAYER_1_RID,
                scaleResolutionDownBy: browser.isFirefox() ? 1.0 : 4.0
            },
            {
                active: true,
                maxBitrate: this.videoBitrates.standard,
                rid: SIM_LAYER_2_RID,
                scaleResolutionDownBy: 2.0
            },
            {
                active: true,
                maxBitrate: browser.isFirefox() ? this.videoBitrates.low : this.videoBitrates.high,
                rid: SIM_LAYER_3_RID,
                scaleResolutionDownBy: browser.isFirefox() ? 4.0 : 1.0
            }
        ];
    }

    /**
     * Ensures that the ssrcs associated with a FID ssrc-group appear in the correct order, i.e.,
     * the primary ssrc first and the secondary rtx ssrc later. This is important for unified
     * plan since we have only one FID group per media description.
     * @param {Object} description the webRTC session description instance for the remote
     * description.
     * @private
     */
    ensureCorrectOrderOfSsrcs(description) {
        const parsedSdp = transform.parse(description.sdp);

        parsedSdp.media.forEach(mLine => {
            if (mLine.type === 'audio') {
                return;
            }
            if (!mLine.ssrcGroups || !mLine.ssrcGroups.length) {
                return;
            }
            let reorderedSsrcs = [];

            const ssrcs = new Set();

            mLine.ssrcGroups.map(group =>
                group.ssrcs
                    .split(' ')
                    .filter(Boolean)
                    .forEach(ssrc => ssrcs.add(ssrc))
            );

            ssrcs.forEach(ssrc => {
                const sources = mLine.ssrcs.filter(source => source.id.toString() === ssrc);

                reorderedSsrcs = reorderedSsrcs.concat(sources);
            });
            mLine.ssrcs = reorderedSsrcs;
        });

        return new RTCSessionDescription({
            type: description.type,
            sdp: transform.write(parsedSdp)
        });
    }

    /**
     * Obtains stream encodings that need to be configured on the given track based
     * on the track media type and the simulcast setting.
     * @param {JitsiLocalTrack} localTrack
     */
    _getStreamEncodings(localTrack) {
        if (this.pc.isSimulcastOn() && localTrack.isVideoTrack()) {
            return this.localStreamEncodingsConfig;
        }

        return localTrack.isVideoTrack()
            ? [ {
                active: true,
                maxBitrate: this.videoBitrates.high
            } ]
            : [ { active: true } ];
    }

    /**
     * Takes in a *unified plan* offer and inserts the appropriate
     * parameters for adding simulcast receive support.
     * @param {Object} desc - A session description object
     * @param {String} desc.type - the type (offer/answer)
     * @param {String} desc.sdp - the sdp content
     *
     * @return {Object} A session description (same format as above) object
     * with its sdp field modified to advertise simulcast receive support
     */
    insertUnifiedPlanSimulcastReceive(desc) {
        // a=simulcast line is not needed on browsers where
        // we munge SDP for turning on simulcast. Remove this check
        // when we move to RID/MID based simulcast on all browsers.
        if (browser.usesSdpMungingForSimulcast()) {
            return desc;
        }
        const sdp = transform.parse(desc.sdp);
        const idx = sdp.media.findIndex(mline => mline.type === 'video');

        if (sdp.media[idx].rids && (sdp.media[idx].simulcast_03 || sdp.media[idx].simulcast)) {
            // Make sure we don't have the simulcast recv line on video descriptions other than the
            // the first video description.
            sdp.media.forEach((mline, i) => {
                if (mline.type === 'video' && i !== idx) {
                    sdp.media[i].rids = undefined;
                    sdp.media[i].simulcast = undefined;

                    // eslint-disable-next-line camelcase
                    sdp.media[i].simulcast_03 = undefined;
                }
            });

            return new RTCSessionDescription({
                type: desc.type,
                sdp: transform.write(sdp)
            });
        }

        // In order of highest to lowest spatial quality
        sdp.media[idx].rids = [
            {
                id: SIM_LAYER_1_RID,
                direction: 'recv'
            },
            {
                id: SIM_LAYER_2_RID,
                direction: 'recv'
            },
            {
                id: SIM_LAYER_3_RID,
                direction: 'recv'
            }
        ];

        // Firefox 72 has stopped parsing the legacy rid= parameters in simulcast attributes.
        // eslint-disable-next-line max-len
        // https://www.fxsitecompat.dev/en-CA/docs/2019/pt-and-rid-in-webrtc-simulcast-attributes-are-no-longer-supported/
        const simulcastLine = browser.isFirefox() && browser.isVersionGreaterThan(71)
            ? `recv ${SIM_LAYER_RIDS.join(';')}`
            : `recv rid=${SIM_LAYER_RIDS.join(';')}`;

        // eslint-disable-next-line camelcase
        sdp.media[idx].simulcast_03 = {
            value: simulcastLine
        };

        return new RTCSessionDescription({
            type: desc.type,
            sdp: transform.write(sdp)
        });
    }

    /**
    * Adds {@link JitsiLocalTrack} to the WebRTC peerconnection for the first time.
    * @param {JitsiLocalTrack} track - track to be added to the peerconnection.
    * @param {boolean} isInitiator - boolean that indicates if the endpoint is offerer
    * in a p2p connection.
    * @returns {void}
    */
    addTrack(localTrack, isInitiator) {
        const track = localTrack.getTrack();

        if (isInitiator) {
            // Use pc.addTransceiver() for the initiator case when local tracks are getting added
            // to the peerconnection before a session-initiate is sent over to the peer.
            const transceiverInit = {
                direction: 'sendrecv',
                streams: [ localTrack.getOriginalStream() ],
                sendEncodings: []
            };

            if (!browser.isFirefox()) {
                transceiverInit.sendEncodings = this._getStreamEncodings(localTrack);
            }
            this.pc.peerconnection.addTransceiver(track, transceiverInit);
        } else {
            // Use pc.addTrack() for responder case so that we can re-use the m-lines that were created
            // when setRemoteDescription was called. pc.addTrack() automatically  attaches to any existing
            // unused "recv-only" transceiver.
            this.pc.peerconnection.addTrack(track);
        }
    }

    /**
     * Adds a track on the RTCRtpSender as part of the unmute operation.
     * @param {JitsiLocalTrack} localTrack - track to be unmuted.
     * @returns {Promise<void>} - resolved when done.
     */
    addTrackUnmute(localTrack) {
        const mediaType = localTrack.getType();
        const track = localTrack.getTrack();

        // The assumption here is that the first transceiver of the specified
        // media type is that of the local track.
        const transceiver = this.pc.peerconnection.getTransceivers()
            .find(t => t.receiver && t.receiver.track && t.receiver.track.kind === mediaType);

        if (!transceiver) {
            return Promise.reject(new Error(`RTCRtpTransceiver for ${mediaType} not found`));
        }
        logger.debug(`Adding ${localTrack} on ${this.pc}`);

        // If the client starts with audio/video muted setting, the transceiver direction
        // will be set to 'recvonly'. Use addStream here so that a MSID is generated for the stream.
        if (transceiver.direction === 'recvonly') {
            const stream = localTrack.getOriginalStream();

            if (stream) {
                this.pc.peerconnection.addStream(localTrack.getOriginalStream());

                return this.setEncodings(localTrack).then(() => {
                    this.pc.localTracks.set(localTrack.rtcId, localTrack);
                    transceiver.direction = 'sendrecv';
                });
            }

            return Promise.resolve();
        }

        return transceiver.sender.replaceTrack(track);
    }

    /**
     * Obtains the current local video track's height constraints based on the
     * initial stream encodings configuration on the sender and the resolution
     * of the current local track added to the peerconnection.
     * @param {MediaStreamTrack} localTrack local video track
     * @returns {Array[number]} an array containing the resolution heights of
     * simulcast streams configured on the video sender.
     */
    getLocalStreamHeightConstraints(localTrack) {
        // React-native hasn't implemented MediaStreamTrack getSettings yet.
        if (browser.isReactNative()) {
            return null;
        }

        const localVideoHeightConstraints = [];
        const height = localTrack.getSettings().height;

        for (const encoding of this.localStreamEncodingsConfig) {
            localVideoHeightConstraints.push(height / encoding.scaleResolutionDownBy);
        }

        return localVideoHeightConstraints;
    }

    /**
     * Removes the track from the RTCRtpSender as part of the mute operation.
     * @param {JitsiLocalTrack} localTrack - track to be removed.
     * @returns {Promise<void>} - resolved when done.
     */
    removeTrackMute(localTrack) {
        const mediaType = localTrack.getType();
        const transceiver = this.pc.peerconnection.getTransceivers()
            .find(t => t.sender && t.sender.track && t.sender.track.id === localTrack.getTrackId());

        if (!transceiver) {
            return Promise.reject(new Error(`RTCRtpTransceiver for ${mediaType} not found`));
        }

        logger.debug(`Removing ${localTrack} on ${this.pc}`);

        return transceiver.sender.replaceTrack(null);
    }

    /**
     * Returns the calculated active state of the simulcast encodings based on the frame height requested for the send
     * stream. All the encodings that have a resolution lower than the frame height requested will be enabled.
     *
     * @param {JitsiLocalTrack} localVideoTrack The local video track.
     * @param {number} newHeight The resolution requested for the video track.
     * @returns {Array<boolean>}
     */
     calculateEncodingsActiveState(localVideoTrack, newHeight) {
        const localTrack = localVideoTrack.getTrack();
        const { height } = localTrack.getSettings();
        const encodingsState = this.localStreamEncodingsConfig
        .map(encoding => height / encoding.scaleResolutionDownBy)
        .map((frameHeight, idx) => {
            let active = localVideoTrack.getVideoType() === VideoType.CAMERA

                // Keep the LD stream enabled even when the LD stream's resolution is higher than of the requested
                // resolution. This can happen when camera is captured at resolutions higher than 720p but the
                // requested resolution is 180. Since getParameters doesn't give us information about the resolutions
                // of the simulcast encodings, we have to rely on our initial config for the simulcast streams.
                ? newHeight > 0 && this.localStreamEncodingsConfig[idx]?.scaleResolutionDownBy === LD_SCALE_FACTOR
                    ? true
                    : frameHeight <= newHeight

                // Keep all the encodings for desktop track active.
                : true;

            // Disable the lower spatial layers for screensharing in Unified plan when low fps screensharing is in
            // progress. Sending all three streams often results in the browser suspending the high resolution in low
            // b/w and cpu cases, especially on the low end machines. Suspending the low resolution streams ensures
            // that the highest resolution stream is available always. Safari is an exception here since it does not
            // send the desktop stream at all if only the high resolution stream is enabled.
            if (this.pc.isSharingLowFpsScreen()
                && localVideoTrack.getVideoType() === VideoType.DESKTOP
                && this.pc.usesUnifiedPlan()
                && !browser.isWebKitBased()
                && this.localStreamEncodingsConfig[idx].scaleResolutionDownBy !== HD_SCALE_FACTOR) {
                active = false;
            }

            return active;
        });

        return encodingsState;
    }

    /**
     * Returns the calculates max bitrates that need to be configured on the simulcast encodings based on the video
     * type and other considerations associated with screenshare.
     *
     * @param {JitsiLocalTrack} localVideoTrack The local video track.
     * @returns {Array<number>}
     */
    calculateEncodingsBitrates(localVideoTrack) {
        const videoType = localVideoTrack.getVideoType();
        const desktopShareBitrate = this.pc.options?.videoQuality?.desktopBitrate || DESKTOP_SHARE_RATE;
        const presenterEnabled = localVideoTrack._originalStream
            && localVideoTrack._originalStream.id !== localVideoTrack.getStreamId();

        const encodingsBitrates = this.localStreamEncodingsConfig
        .map(encoding => {
            const bitrate = this.pc.isSharingLowFpsScreen() && !browser.isWebKitBased()

                // For low fps screensharing, set a max bitrate of 500 Kbps when presenter is not turned on, 2500 Kbps
                // otherwise.
                ? presenterEnabled ? HD_BITRATE : desktopShareBitrate

                // For high fps screenshare, 'maxBitrate' setting must be cleared on Chrome in plan-b, because
                // if simulcast is enabled for screen and maxBitrates are set then Chrome will not send the
                // desktop stream.
                : videoType === VideoType.DESKTOP && browser.isChromiumBased() && !this.pc.usesUnifiedPlan()
                    ? undefined
                    : encoding.maxBitrate;

            return bitrate;
        });

        return encodingsBitrates;
    }

    /**
     * Replaces the existing track on a RTCRtpSender with the given track.
     * @param {JitsiLocalTrack} oldTrack - existing track on the sender that needs to be removed.
     * @param {JitsiLocalTrack} newTrack - new track that needs to be added to the sender.
     * @returns {Promise<void>} - resolved when done.
     */
    replaceTrack(oldTrack, newTrack) {
        const mediaType = newTrack?.getType() ? newTrack?.getType() : oldTrack?.getType();
        const track = newTrack?.getTrack() ? newTrack?.getTrack() : null;
        const isNewLocalSource = FeatureFlags.isMultiStreamSupportEnabled()
            && this.pc.getLocalTracks(mediaType)?.length
            && !oldTrack
            && newTrack
            && !newTrack.conference;
        let transceiver;

        // If old track exists, replace the track on the corresponding sender.
        if (oldTrack && !oldTrack.isMuted()) {
            transceiver = this.pc.peerconnection.getTransceivers().find(t => t.sender.track === oldTrack.getTrack());

        // Find the first recvonly transceiver when more than one track of the same media type is being added to the pc.
        // As part of the track addition, a new m-line was added to the remote description with direction set to
        // recvonly.
        } else if (isNewLocalSource) {
            transceiver = this.pc.peerconnection.getTransceivers().find(
                t => t.receiver.track.kind === mediaType
                && t.direction === MediaDirection.RECVONLY
                && t.currentDirection === MediaDirection.INACTIVE);

        // For mute/unmute operations, find the transceiver based on the track index in the source name if present,
        // otherwise it is assumed to be the first local track that was added to the peerconnection.
        } else {
            transceiver = this.pc.peerconnection.getTransceivers().find(t => t.receiver.track.kind === mediaType);
            const sourceName = newTrack?.getSourceName() ? newTrack?.getSourceName() : oldTrack?.getSourceName();

            if (sourceName) {
                const trackIndex = Number(sourceName.split('-')[1].substring(1));

                if (trackIndex) {
                    transceiver = this.pc.peerconnection.getTransceivers()
                        .filter(t => t.receiver.track.kind === mediaType
                            && t.direction !== MediaDirection.RECVONLY)[trackIndex];
                }
            }
        }

        if (!transceiver) {
            return Promise.reject(new Error('replace track failed'));
        }
        logger.debug(`${this.pc} Replacing ${oldTrack} with ${newTrack}`);

        return transceiver.sender.replaceTrack(track)
            .then(() => Promise.resolve(transceiver));
    }

    /**
    * Enables/disables audio transmission on the peer connection. When
    * disabled the audio transceiver direction will be set to 'inactive'
    * which means that no data will be sent nor accepted, but
    * the connection should be kept alive.
    * @param {boolean} active - true to enable audio media transmission or
    * false to disable.
    * @returns {void}
    */
    setAudioTransferActive(active) {
        this.setMediaTransferActive(MediaType.AUDIO, active);
    }

    /**
     * Set the simulcast stream encoding properties on the RTCRtpSender.
     * @param {JitsiLocalTrack} track - the current track in use for which
     * the encodings are to be set.
     * @returns {Promise<void>} - resolved when done.
     */
    setEncodings(track) {
        const transceiver = this.pc.peerconnection.getTransceivers()
            .find(t => t.sender && t.sender.track && t.sender.track.kind === track.getType());
        const parameters = transceiver.sender.getParameters();

        parameters.encodings = this._getStreamEncodings(track);

        return transceiver.sender.setParameters(parameters);
    }

    /**
     * Enables/disables media transmission on the peerconnection by changing the direction
     * on the transceiver for the specified media type.
     * @param {String} mediaType - 'audio' or 'video'
     * @param {boolean} active - true to enable media transmission or false
     * to disable.
     * @returns {void}
     */
    setMediaTransferActive(mediaType, active) {
        const transceivers = this.pc.peerconnection.getTransceivers()
            .filter(t => t.receiver && t.receiver.track && t.receiver.track.kind === mediaType);
        const localTracks = this.pc.getLocalTracks(mediaType);

        logger.info(`${active ? 'Enabling' : 'Suspending'} ${mediaType} media transfer on ${this.pc}`);
        transceivers.forEach((transceiver, idx) => {
            if (active) {
                // The first transceiver is for the local track and only this one can be set to 'sendrecv'
                if (idx === 0 && localTracks.length) {
                    transceiver.direction = 'sendrecv';
                } else {
                    transceiver.direction = 'recvonly';
                }
            } else {
                transceiver.direction = 'inactive';
            }
        });
    }

    /**
    * Enables/disables video media transmission on the peer connection. When
    * disabled the SDP video media direction in the local SDP will be adjusted to
    * 'inactive' which means that no data will be sent nor accepted, but
    * the connection should be kept alive.
    * @param {boolean} active - true to enable video media transmission or
    * false to disable.
    * @returns {void}
    */
    setVideoTransferActive(active) {
        this.setMediaTransferActive(MediaType.VIDEO, active);
    }
}
