/**
 * webrtc.js - WebRTC 连接管理
 * 负责：RTCPeerConnection 创建与管理、DataChannel 创建、ICE 交换、Offer/Answer 流程
 */
(function () {
    'use strict';

    // ===================== 连接存储 =====================

    /**
     * @typedef {Object} PeerConn
     * @property {RTCPeerConnection} pc - RTCPeerConnection 实例
     * @property {RTCDataChannel[]} channels - DataChannel 数组（4个并发通道）
     * @property {string} deviceId - 对端设备 ID
     * @property {string} state - 连接状态: 'connecting' | 'connected' | 'disconnected'
     */

    /** @type {Map<string, PeerConn>} deviceId -> PeerConn */
    const connections = new Map();

    /** @type {number} 每个连接创建的 DataChannel 数量 */
    const CHANNEL_COUNT = 4;

    /** @type {RTCConfiguration} */
    const rtcConfig = {
        iceServers: [] // 局域网内不需要 STUN/TURN
    };

    // ===================== 创建连接 =====================

    /**
     * 创建到目标设备的 PeerConnection（发起方，创建 Offer）
     * @param {string} deviceId - 目标设备 ID
     * @returns {PeerConn}
     */
    function createPeerConnection(deviceId) {
        // 如果已存在连接，先关闭
        if (connections.has(deviceId)) {
            closeConnection(deviceId);
        }

        var pc = new RTCPeerConnection(rtcConfig);

        var peerConn = {
            pc: pc,
            channels: [],
            deviceId: deviceId,
            state: 'connecting'
        };

        // ICE candidate 处理
        pc.onicecandidate = function (event) {
            if (event.candidate) {
                Flit.send({
                    type: 'ice_candidate',
                    to: deviceId,
                    candidate: event.candidate.toJSON()
                });
            }
        };

        // 连接状态变化
        pc.onconnectionstatechange = function () {
            console.log('[WebRTC] 连接状态变化:', pc.connectionState, 'to', deviceId);
            peerConn.state = pc.connectionState;

            if (pc.connectionState === 'connected') {
                console.log('[WebRTC] 已与', deviceId, '建立连接');
                Flit.ui.toast('与 ' + (Flit.getDevice(deviceId)?.name || deviceId) + ' 已建立连接', 'success');
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                console.log('[WebRTC] 与', deviceId, '的连接断开');
                Flit.ui.toast('与 ' + (Flit.getDevice(deviceId)?.name || deviceId) + ' 的连接已断开', 'error');
                // 清理该设备相关的传输任务
                Flit.transfer.onConnectionLost(deviceId);
            }
        };

        // ICE 连接状态变化
        pc.oniceconnectionstatechange = function () {
            console.log('[WebRTC] ICE 状态:', pc.iceConnectionState, 'to', deviceId);
        };

        // 创建多个 DataChannel 用于并发传输
        for (var i = 0; i < CHANNEL_COUNT; i++) {
            var channelName = 'data-' + i;
            var channel = pc.createDataChannel(channelName, {
                ordered: false // 无序传输提高速度，传输层自行处理排序
            });

            setupDataChannel(channel, deviceId, i);
            peerConn.channels.push(channel);
        }

        connections.set(deviceId, peerConn);
        return peerConn;
    }

    /**
     * 接收方创建 PeerConnection（接收 Offer）
     * @param {string} deviceId - 对端设备 ID
     * @returns {PeerConn}
     */
    function createPeerConnectionAsReceiver(deviceId) {
        if (connections.has(deviceId)) {
            closeConnection(deviceId);
        }

        var pc = new RTCPeerConnection(rtcConfig);

        var peerConn = {
            pc: pc,
            channels: [],
            deviceId: deviceId,
            state: 'connecting'
        };

        // ICE candidate 处理
        pc.onicecandidate = function (event) {
            if (event.candidate) {
                Flit.send({
                    type: 'ice_candidate',
                    to: deviceId,
                    candidate: event.candidate.toJSON()
                });
            }
        };

        // 连接状态变化
        pc.onconnectionstatechange = function () {
            console.log('[WebRTC] 接收方连接状态变化:', pc.connectionState, 'from', deviceId);
            peerConn.state = pc.connectionState;

            if (pc.connectionState === 'connected') {
                console.log('[WebRTC] 已与', deviceId, '建立连接（接收方）');
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                Flit.transfer.onConnectionLost(deviceId);
            }
        };

        // 接收对方创建的 DataChannel
        pc.ondatachannel = function (event) {
            console.log('[WebRTC] 收到 DataChannel:', event.channel.label, 'from', deviceId);
            setupDataChannel(event.channel, deviceId, peerConn.channels.length);
            peerConn.channels.push(event.channel);
        };

        connections.set(deviceId, peerConn);
        return peerConn;
    }

    // ===================== DataChannel 配置 =====================

    /**
     * 配置 DataChannel 的事件处理
     * @param {RTCDataChannel} channel
     * @param {string} deviceId
     * @param {number} channelIndex
     */
    function setupDataChannel(channel, deviceId, channelIndex) {
        channel.binaryType = 'arraybuffer';

        channel.onopen = function () {
            console.log('[WebRTC] DataChannel 已打开:', channel.label, '->', deviceId);
        };

        channel.onclose = function () {
            console.log('[WebRTC] DataChannel 已关闭:', channel.label, '->', deviceId);
        };

        channel.onerror = function (error) {
            console.error('[WebRTC] DataChannel 错误:', channel.label, error);
        };

        // 收到消息（包括二进制数据）
        channel.onmessage = function (event) {
            if (event.data instanceof ArrayBuffer) {
                // 二进制数据 - 文件分片
                Flit.transfer.handleBinaryMessage(deviceId, event.data, channelIndex);
            } else {
                // 文本消息 - 控制命令
                try {
                    var msg = JSON.parse(event.data);
                    Flit.transfer.handleControlMessage(deviceId, msg, channelIndex);
                } catch (e) {
                    console.error('[WebRTC] 消息解析失败:', e);
                }
            }
        };
    }

    // ===================== 发起连接（Offer 方） =====================

    /**
     * 发起 WebRTC 连接（发送方调用）
     * @param {string} deviceId - 目标设备 ID
     */
    function initiateConnection(deviceId) {
        var peerConn = createPeerConnection(deviceId);

        // 创建 Offer
        peerConn.pc.createOffer()
            .then(function (offer) {
                return peerConn.pc.setLocalDescription(offer);
            })
            .then(function () {
                Flit.send({
                    type: 'webrtc_offer',
                    to: deviceId,
                    sdp: peerConn.pc.localDescription.sdp
                });
                console.log('[WebRTC] 已发送 Offer 到', deviceId);
            })
            .catch(function (error) {
                console.error('[WebRTC] 创建 Offer 失败:', error);
                Flit.ui.toast('建立连接失败: ' + error.message, 'error');
            });
    }

    // ===================== 处理 Offer（接收方） =====================

    /**
     * 处理收到的 WebRTC Offer
     * @param {Object} msg - {type, to, from, sdp}
     */
    function handleOffer(msg) {
        var deviceId = msg.from;
        if (!deviceId) {
            console.warn('[WebRTC] Offer 缺少 from 字段');
            return;
        }

        console.log('[WebRTC] 收到 Offer 来自', deviceId);

        var peerConn = createPeerConnectionAsReceiver(deviceId);

        var remoteDesc = new RTCSessionDescription({ type: 'offer', sdp: msg.sdp });
        peerConn.pc.setRemoteDescription(remoteDesc)
            .then(function () {
                return peerConn.pc.createAnswer();
            })
            .then(function (answer) {
                return peerConn.pc.setLocalDescription(answer);
            })
            .then(function () {
                Flit.send({
                    type: 'webrtc_answer',
                    to: deviceId,
                    sdp: peerConn.pc.localDescription.sdp
                });
                console.log('[WebRTC] 已发送 Answer 到', deviceId);
            })
            .catch(function (error) {
                console.error('[WebRTC] 处理 Offer 失败:', error);
            });
    }

    // ===================== 处理 Answer（发起方） =====================

    /**
     * 处理收到的 WebRTC Answer
     * @param {Object} msg - {type, to, from, sdp}
     */
    function handleAnswer(msg) {
        var deviceId = msg.from;
        if (!deviceId) {
            console.warn('[WebRTC] Answer 缺少 from 字段');
            return;
        }

        var peerConn = connections.get(deviceId);
        if (!peerConn) {
            console.warn('[WebRTC] 未找到对应连接:', deviceId);
            return;
        }

        console.log('[WebRTC] 收到 Answer 来自', deviceId);

        var remoteDesc = new RTCSessionDescription({ type: 'answer', sdp: msg.sdp });
        peerConn.pc.setRemoteDescription(remoteDesc)
            .then(function () {
                console.log('[WebRTC] 已设置远程描述（Answer）');
            })
            .catch(function (error) {
                console.error('[WebRTC] 设置 Answer 失败:', error);
            });
    }

    // ===================== ICE Candidate 处理 =====================

    /**
     * 处理收到的 ICE Candidate
     * @param {Object} msg - {type, to, from, candidate}
     */
    function handleICECandidate(msg) {
        var deviceId = msg.from;
        if (!deviceId) return;

        var peerConn = connections.get(deviceId);
        if (!peerConn) {
            console.warn('[WebRTC] 收到 ICE Candidate 但未找到连接:', deviceId);
            return;
        }

        var candidate = new RTCIceCandidate(msg.candidate);
        peerConn.pc.addIceCandidate(candidate)
            .catch(function (error) {
                console.error('[WebRTC] 添加 ICE Candidate 失败:', error);
            });
    }

    // ===================== 获取通道 =====================

    /**
     * 获取到目标设备的可用 DataChannel
     * @param {string} deviceId
     * @param {number} channelIndex - 通道索引（0-3）
     * @returns {RTCDataChannel|null}
     */
    function getChannel(deviceId, channelIndex) {
        var peerConn = connections.get(deviceId);
        if (!peerConn) return null;

        var channel = peerConn.channels[channelIndex];
        if (channel && channel.readyState === 'open') {
            return channel;
        }
        return null;
    }

    /**
     * 获取到目标设备的所有已打开的 DataChannel
     * @param {string} deviceId
     * @returns {RTCDataChannel[]}
     */
    function getOpenChannels(deviceId) {
        var peerConn = connections.get(deviceId);
        if (!peerConn) return [];

        return peerConn.channels.filter(function (ch) {
            return ch.readyState === 'open';
        });
    }

    /**
     * 检查是否已连接
     * @param {string} deviceId
     * @returns {boolean}
     */
    function isConnected(deviceId) {
        var peerConn = connections.get(deviceId);
        if (!peerConn) return false;
        return peerConn.pc.connectionState === 'connected';
    }

    // ===================== 关闭连接 =====================

    /**
     * 关闭与指定设备的连接
     * @param {string} deviceId
     */
    function closeConnection(deviceId) {
        var peerConn = connections.get(deviceId);
        if (!peerConn) return;

        console.log('[WebRTC] 关闭与', deviceId, '的连接');

        // 关闭所有 DataChannel
        peerConn.channels.forEach(function (ch) {
            try {
                ch.close();
            } catch (e) { /* 忽略关闭错误 */ }
        });

        // 关闭 PeerConnection
        try {
            peerConn.pc.close();
        } catch (e) { /* 忽略关闭错误 */ }

        connections.delete(deviceId);
    }

    /**
     * 关闭所有连接
     */
    function closeAllConnections() {
        connections.forEach(function (peerConn, deviceId) {
            closeConnection(deviceId);
        });
    }

    // ===================== 暴露到全局 =====================

    window.Flit = window.Flit || {};
    window.Flit.webrtc = {
        createPeerConnection: createPeerConnection,
        createPeerConnectionAsReceiver: createPeerConnectionAsReceiver,
        initiateConnection: initiateConnection,
        handleOffer: handleOffer,
        handleAnswer: handleAnswer,
        handleICECandidate: handleICECandidate,
        getChannel: getChannel,
        getOpenChannels: getOpenChannels,
        isConnected: isConnected,
        closeConnection: closeConnection,
        closeAllConnections: closeAllConnections,
        connections: connections
    };

})();
