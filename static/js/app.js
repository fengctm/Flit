/**
 * app.js - 主入口 + WebSocket 管理
 * 负责：WebSocket 连接与重连、消息分发、设备管理、多选模式、全局对象暴露
 */
(function () {
    'use strict';

    // ===================== 设备信息类型定义 =====================
    /**
     * @typedef {Object} DeviceInfo
     * @property {string} id - 设备唯一 ID
     * @property {string} name - 设备名称（如 "Xiaomi14 / 192.168.1.5"）
     * @property {string} ip - 设备 IP 地址
     * @property {string} os - 操作系统类型
     */

    // ===================== 全局状态 =====================
    /** @type {WebSocket|null} */
    let ws = null;

    /** @type {Map<string, DeviceInfo>} 已连接的设备列表 */
    const devices = new Map();

    /** @type {Set<string>} 当前选中的设备 ID 集合 */
    const selectedDevices = new Set();

    /** @type {boolean} 是否处于多选模式 */
    let multiSelectMode = false;

    /** @type {string|null} 当前设备自身 ID */
    let selfDeviceId = null;

    /** @type {number} 重连定时器 */
    let reconnectTimer = null;

    /** @type {number} 重连延迟（毫秒） */
    const RECONNECT_DELAY = 2000;

    /** @type {number} 心跳定时器 */
    let heartbeatTimer = null;

    // ===================== WebSocket 连接管理 =====================

    /**
     * 建立 WebSocket 连接
     */
    function connect() {
        // 防止重复连接
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws`;

        try {
            ws = new WebSocket(url);
        } catch (e) {
            console.error('WebSocket 创建失败:', e);
            scheduleReconnect();
            return;
        }

        // 连接成功
        ws.onopen = function () {
            console.log('[WS] 已连接到信令服务器');
            updateConnectionStatus(true);
            clearReconnectTimer();

            // 发送设备注册消息
            registerDevice();

            // 启动心跳
            startHeartbeat();
        };

        // 收到消息
        ws.onmessage = function (event) {
            try {
                const msg = JSON.parse(event.data);
                dispatchMessage(msg);
            } catch (e) {
                console.error('[WS] 消息解析失败:', e);
            }
        };

        // 连接关闭
        ws.onclose = function (event) {
            console.log('[WS] 连接关闭, code:', event.code);
            updateConnectionStatus(false);
            stopHeartbeat();
            scheduleReconnect();
        };

        // 连接错误
        ws.onerror = function (error) {
            console.error('[WS] 连接错误:', error);
        };
    }

    /**
     * 安排重连
     */
    function scheduleReconnect() {
        clearReconnectTimer();
        reconnectTimer = setTimeout(function () {
            console.log('[WS] 尝试重新连接...');
            connect();
        }, RECONNECT_DELAY);
    }

    /**
     * 清除重连定时器
     */
    function clearReconnectTimer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    /**
     * 启动心跳定时器（每 30 秒发送 ping）
     */
    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = setInterval(function () {
            if (ws && ws.readyState === WebSocket.OPEN) {
                send({ type: 'ping' });
            }
        }, 30000);
    }

    /**
     * 停止心跳
     */
    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    /**
     * 发送消息到服务器
     * @param {Object} msg - 消息对象
     */
    function send(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        } else {
            console.warn('[WS] 连接未就绪，消息未发送:', msg);
        }
    }

    // ===================== 消息分发 =====================

    /**
     * 根据消息类型分发到对应处理函数
     * @param {Object} msg - 服务端消息
     */
    function dispatchMessage(msg) {
        switch (msg.type) {
            case 'device_list':
                handleDeviceList(msg.data);
                break;
            case 'device_online':
                handleDeviceOnline(msg.data);
                break;
            case 'device_offline':
                handleDeviceOffline(msg.data);
                break;
            case 'send_request':
                handleSendRequest(msg.data);
                break;
            case 'send_response':
                handleSendResponse(msg.data);
                break;
            case 'webrtc_offer':
                handleWebRTCOffer(msg);
                break;
            case 'webrtc_answer':
                handleWebRTCAnswer(msg);
                break;
            case 'ice_candidate':
                handleICECandidate(msg);
                break;
            case 'registered':
                handleRegistered(msg.data);
                break;
            case 'error':
                console.error('[Server] 错误:', msg.message);
                Flit.ui.toast(msg.message || '服务器错误', 'error');
                break;
            default:
                console.log('[WS] 未知消息类型:', msg.type);
        }
    }

    // ===================== 设备注册 =====================

    /**
     * 向服务器注册本设备
     */
    function registerDevice() {
        const deviceInfo = getDeviceInfo();
        send({
            type: 'register',
            device: deviceInfo
        });
    }

    /**
     * 获取本设备信息（通过 User-Agent 推断）
     * @returns {{name: string, os: string}}
     */
    function getDeviceInfo() {
        const ua = navigator.userAgent;
        let os = 'Unknown';
        let name = '';

        if (/Windows/i.test(ua)) {
            os = 'Windows';
            name = 'Windows PC';
        } else if (/Android/i.test(ua)) {
            os = 'Android';
            name = 'Android Device';
        } else if (/iPhone|iPad|iPod/i.test(ua)) {
            os = 'iOS';
            name = 'iOS Device';
        } else if (/Mac OS X/i.test(ua)) {
            os = 'Mac';
            name = 'Mac';
        } else if (/Linux/i.test(ua)) {
            os = 'Linux';
            name = 'Linux PC';
        }

        // 尝试获取主机名的一部分作为名称
        if (!name || name === 'Unknown') {
            name = navigator.platform || 'Unknown Device';
        }

        return { name: name, os: os };
    }

    /**
     * 处理注册成功响应
     * @param {Object} data - {id: string}
     */
    function handleRegistered(data) {
        selfDeviceId = data.id;
        console.log('[App] 已注册，设备 ID:', selfDeviceId);
    }

    // ===================== 设备列表管理 =====================

    /**
     * 处理设备列表更新（全量）
     * @param {{devices: DeviceInfo[]}} data
     */
    function handleDeviceList(data) {
        devices.clear();
        if (data.devices && Array.isArray(data.devices)) {
            data.devices.forEach(function (device) {
                devices.set(device.id, device);
            });
        }
        // 清理选中集合中不存在的设备
        cleanSelection();
        // 更新 UI
        Flit.ui.renderDeviceGrid(devices);
        Flit.ui.updateDeviceCount(devices.size);
    }

    /**
     * 处理新设备上线
     * @param {{device: DeviceInfo}} data
     */
    function handleDeviceOnline(data) {
        if (data.device) {
            devices.set(data.device.id, data.device);
            cleanSelection();
            Flit.ui.renderDeviceGrid(devices);
            Flit.ui.updateDeviceCount(devices.size);
        }
    }

    /**
     * 处理设备离线
     * @param {{deviceID: string}} data
     */
    function handleDeviceOffline(data) {
        if (data.deviceID) {
            devices.delete(data.deviceID);
            selectedDevices.delete(data.deviceID);
            // 关闭与该设备的 WebRTC 连接
            Flit.webrtc.closeConnection(data.deviceID);
            Flit.ui.renderDeviceGrid(devices);
            Flit.ui.updateDeviceCount(devices.size);
            Flit.ui.updateFabVisibility(selectedDevices.size);
        }
    }

    // ===================== 发送请求处理 =====================

    /**
     * 处理来自远程的文件发送请求
     * @param {Object} data - {to, from, files: [{name, size}]}
     */
    function handleSendRequest(data) {
        Flit.ui.showReceiveRequestDialog(data);
    }

    /**
     * 处理发送请求的响应（对方已接受/拒绝）
     * @param {Object} data - {to, from, accepted: boolean}
     */
    function handleSendResponse(data) {
        if (data.accepted) {
            console.log('[App] 对方已接受文件传输请求');
            Flit.ui.toast('对方已接受传输请求，正在建立连接...', 'success');
            // 发起 WebRTC 连接
            Flit.webrtc.initiateConnection(data.from);
        } else {
            console.log('[App] 对方拒绝了文件传输请求');
            Flit.ui.toast('对方拒绝了传输请求', 'warning');
        }
    }

    // ===================== WebRTC 信令转发 =====================

    /**
     * 处理 WebRTC Offer
     */
    function handleWebRTCOffer(msg) {
        Flit.webrtc.handleOffer(msg);
    }

    /**
     * 处理 WebRTC Answer
     */
    function handleWebRTCAnswer(msg) {
        Flit.webrtc.handleAnswer(msg);
    }

    /**
     * 处理 ICE Candidate
     */
    function handleICECandidate(msg) {
        Flit.webrtc.handleICECandidate(msg);
    }

    // ===================== 多选模式管理 =====================

    /**
     * 进入多选模式
     */
    function enterMultiSelectMode() {
        if (multiSelectMode) return;
        multiSelectMode = true;
        document.body.classList.add('multi-select-mode');
        console.log('[App] 进入多选模式');
    }

    /**
     * 退出多选模式
     */
    function exitMultiSelectMode() {
        multiSelectMode = false;
        selectedDevices.clear();
        document.body.classList.remove('multi-select-mode');
        Flit.ui.clearDeviceSelection();
        Flit.ui.updateFabVisibility(0);
        console.log('[App] 退出多选模式');
    }

    /**
     * 切换设备选中状态
     * @param {string} deviceId
     */
    function toggleDeviceSelection(deviceId) {
        if (selectedDevices.has(deviceId)) {
            selectedDevices.delete(deviceId);
        } else {
            selectedDevices.add(deviceId);
        }
        Flit.ui.updateDeviceSelection(deviceId, selectedDevices.has(deviceId));
        Flit.ui.updateFabVisibility(selectedDevices.size);

        // 如果没有选中任何设备且处于多选模式，退出
        if (selectedDevices.size === 0 && multiSelectMode) {
            exitMultiSelectMode();
        }
    }

    /**
     * 处理设备卡片点击
     * @param {string} deviceId
     * @param {MouseEvent} event
     */
    function handleDeviceClick(deviceId, event) {
        // 如果是右键或在传输区域，不处理
        if (event.button !== 0) return;

        // Ctrl+点击 或 已处于多选模式：切换选中
        if (event.ctrlKey || event.metaKey || multiSelectMode) {
            if (!multiSelectMode) {
                enterMultiSelectMode();
            }
            toggleDeviceSelection(deviceId);
            return;
        }

        // 长按检测：按下时记录，300ms 后检查是否移动
        // 这里简化处理，直接在 mouseup 时判断
    }

    /**
     * 长按设备卡片进入多选
     * @param {string} deviceId
     */
    function handleDeviceLongPress(deviceId) {
        if (!multiSelectMode) {
            enterMultiSelectMode();
        }
        toggleDeviceSelection(deviceId);
    }

    // ===================== 工具函数 =====================

    /**
     * 清理选中集合，移除已不存在的设备
     */
    function cleanSelection() {
        selectedDevices.forEach(function (id) {
            if (!devices.has(id)) {
                selectedDevices.delete(id);
            }
        });
    }

    /**
     * 更新连接状态 UI
     * @param {boolean} connected
     */
    function updateConnectionStatus(connected) {
        const el = document.getElementById('connectionStatus');
        if (el) {
            if (connected) {
                el.textContent = '已连接';
                el.className = 'connection-status connected';
            } else {
                el.textContent = '连接中...';
                el.className = 'connection-status disconnected';
            }
        }
    }

    // ===================== 暴露全局对象 =====================

    /**
     * 获取自身设备 ID
     * @returns {string|null}
     */
    function getSelfId() {
        return selfDeviceId;
    }

    /**
     * 获取设备信息
     * @param {string} deviceId
     * @returns {DeviceInfo|undefined}
     */
    function getDevice(deviceId) {
        return devices.get(deviceId);
    }

    /**
     * 获取所有设备
     * @returns {Map<string, DeviceInfo>}
     */
    function getAllDevices() {
        return devices;
    }

    /**
     * 获取选中的设备 ID 列表
     * @returns {string[]}
     */
    function getSelectedDeviceIds() {
        return Array.from(selectedDevices);
    }

    /**
     * 暴露全局 Flit 对象
     */
    window.Flit = {
        // 子模块（后续由各自文件填充）
        webrtc: window.Flit && window.Flit.webrtc ? window.Flit.webrtc : {},
        transfer: window.Flit && window.Flit.transfer ? window.Flit.transfer : {},
        ui: window.Flit && window.Flit.ui ? window.Flit.ui : {},

        // 核心方法
        connect: connect,
        send: send,
        getSelfId: getSelfId,
        getDevice: getDevice,
        getAllDevices: getAllDevices,
        getSelectedDeviceIds: getSelectedDeviceIds,

        // 多选模式
        enterMultiSelectMode: enterMultiSelectMode,
        exitMultiSelectMode: exitMultiSelectMode,
        handleDeviceClick: handleDeviceClick,
        handleDeviceLongPress: handleDeviceLongPress,
        toggleDeviceSelection: toggleDeviceSelection,

        // 发送文件（由 ui.js 调用）
        requestSendFiles: function (targetDeviceIds, files) {
            if (!selfDeviceId) {
                Flit.ui.toast('尚未连接到服务器', 'error');
                return;
            }
            // 为每个目标设备发送请求
            targetDeviceIds.forEach(function (targetId) {
                const fileInfos = files.map(function (f) {
                    return { name: f.name, size: f.size };
                });
                send({
                    type: 'send_request',
                    data: {
                        to: targetId,
                        from: selfDeviceId,
                        files: fileInfos
                    }
                });
            });
        },

        // 接受文件传输
        acceptTransfer: function (fromDeviceId) {
            send({
                type: 'send_response',
                data: {
                    to: fromDeviceId,
                    accepted: true
                }
            });
        },

        // 拒绝文件传输
        rejectTransfer: function (fromDeviceId) {
            send({
                type: 'send_response',
                data: {
                    to: fromDeviceId,
                    accepted: false
                }
            });
        }
    };

    // ===================== DOM 事件绑定 =====================

    document.addEventListener('DOMContentLoaded', function () {
        // 连接 WebSocket
        connect();

        // ESC 退出多选模式
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && multiSelectMode) {
                exitMultiSelectMode();
            }
        });

        // 清除已完成任务按钮
        var clearBtn = document.getElementById('clearCompleted');
        if (clearBtn) {
            clearBtn.addEventListener('click', function () {
                Flit.ui.clearCompletedTransfers();
            });
        }

        // 文件选择 input 变化
        var fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.addEventListener('change', function (e) {
                var files = Array.from(e.target.files);
                if (files.length === 0) return;

                var selectedIds = Flit.getSelectedDeviceIds();
                if (selectedIds.length === 0) {
                    Flit.ui.toast('请先选择目标设备', 'warning');
                    return;
                }

                // 发送请求
                Flit.requestSendFiles(selectedIds, files);

                // 重置 input 以便再次选择同一文件
                fileInput.value = '';
            });
        }

        // 长按检测支持（touch 和 mouse）
        var longPressTimer = null;
        var longPressTriggered = false;

        document.addEventListener('mousedown', function (e) {
            var card = e.target.closest('.device-card');
            if (!card) return;
            longPressTriggered = false;
            longPressTimer = setTimeout(function () {
                longPressTriggered = true;
                var deviceId = card.getAttribute('data-device-id');
                if (deviceId) {
                    Flit.handleDeviceLongPress(deviceId);
                }
            }, 500);
        });

        document.addEventListener('mouseup', function () {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        document.addEventListener('mousemove', function () {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        // 设备卡片点击事件委托
        document.getElementById('deviceGrid').addEventListener('click', function (e) {
            var card = e.target.closest('.device-card');
            if (!card) return;
            var deviceId = card.getAttribute('data-device-id');
            if (deviceId && !longPressTriggered) {
                Flit.handleDeviceClick(deviceId, e);
            }
        });

        // FAB 按钮点击 - 触发文件选择
        var sendFab = document.getElementById('sendFab');
        if (sendFab) {
            sendFab.addEventListener('click', function () {
                var fileInput = document.getElementById('fileInput');
                if (fileInput) {
                    fileInput.click();
                }
            });
        }

        // 接收请求对话框按钮
        var rejectBtn = document.getElementById('rejectBtn');
        var acceptBtn = document.getElementById('acceptBtn');
        if (rejectBtn) {
            rejectBtn.addEventListener('click', function () {
                var dialog = document.getElementById('sendRequestDialog');
                var fromId = dialog && dialog.getAttribute('data-from-id');
                if (fromId) {
                    Flit.rejectTransfer(fromId);
                }
                Flit.ui.hideReceiveRequestDialog();
            });
        }
        if (acceptBtn) {
            acceptBtn.addEventListener('click', function () {
                var dialog = document.getElementById('sendRequestDialog');
                var fromId = dialog && dialog.getAttribute('data-from-id');
                if (fromId) {
                    Flit.acceptTransfer(fromId);
                }
                Flit.ui.hideReceiveRequestDialog();
            });
        }
    });

})();
