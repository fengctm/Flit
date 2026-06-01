/**
 * ui.js - UI 更新
 * 负责：设备卡片渲染、传输任务渲染、Toast 消息、接收请求弹窗、格式化工具
 */
(function () {
    'use strict';

    // ===================== OS 图标映射 =====================

    const OS_ICONS = {
        'Windows': '\uD83D\uDCBB', // 💻
        'Android': '\uD83D\uDCF1', // 📱
        'iOS':     '\uD83C\uDF4E', // 🍎
        'Mac':     '\uD83D\uDCBB', // 💻
        'Linux':   '\uD83D\uDC27', // 🐧
    };
    const DEFAULT_OS_ICON = '\uD83D\uDCF1'; // 📱

    /**
     * 根据 OS 名称获取图标
     * @param {string} os
     * @returns {string}
     */
    function getOsIcon(os) {
        return OS_ICONS[os] || DEFAULT_OS_ICON;
    }

    // ===================== 设备卡片渲染 =====================

    /**
     * 渲染设备网格
     * @param {Map<string, DeviceInfo>} devices
     */
    function renderDeviceGrid(devices) {
        var grid = document.getElementById('deviceGrid');
        var emptyState = document.getElementById('emptyState');
        if (!grid) return;

        // 记录当前已渲染的设备 ID
        var existingCards = grid.querySelectorAll('.device-card');
        var existingIds = new Set();
        existingCards.forEach(function (card) {
            existingIds.add(card.getAttribute('data-device-id'));
        });

        var targetIds = new Set();
        devices.forEach(function (device, id) {
            targetIds.add(id);

            var existingCard = grid.querySelector('[data-device-id="' + id + '"]');
            if (existingCard) {
                // 更新已有卡片信息
                updateDeviceCardInfo(existingCard, device);
            } else {
                // 创建新卡片（入场动画）
                var card = createDeviceCard(device);
                grid.appendChild(card);
            }
        });

        // 移除不再存在的设备卡片（淡出动画）
        existingCards.forEach(function (card) {
            var cardId = card.getAttribute('data-device-id');
            if (!targetIds.has(cardId)) {
                card.classList.add('removing');
                card.addEventListener('animationend', function () {
                    if (card.parentNode) {
                        card.parentNode.removeChild(card);
                    }
                });
            }
        });

        // 更新空状态显示
        if (emptyState) {
            emptyState.style.display = devices.size === 0 ? 'flex' : 'none';
        }
    }

    /**
     * 创建设备卡片 DOM
     * @param {DeviceInfo} device
     * @returns {HTMLElement}
     */
    function createDeviceCard(device) {
        var card = document.createElement('div');
        card.className = 'device-card';
        card.setAttribute('data-device-id', device.id);
        card.setAttribute('tabindex', '0');

        var name = device.name || device.ip || 'Unknown Device';
        var displayText = device.ip ? name + ' / ' + device.ip : name;

        card.innerHTML =
            '<div class="select-check">\u2713</div>' +
            '<div class="device-icon">' + getOsIcon(device.os) + '</div>' +
            '<div class="device-info">' +
            '  <div class="device-name">' + escapeHtml(displayText) + '</div>' +
            '  <div class="device-meta">' + escapeHtml(device.os || 'Unknown') + '</div>' +
            '</div>' +
            '<div class="device-online-dot"></div>';

        return card;
    }

    /**
     * 更新已有设备卡片的信息
     * @param {HTMLElement} card
     * @param {DeviceInfo} device
     */
    function updateDeviceCardInfo(card, device) {
        var nameEl = card.querySelector('.device-name');
        var metaEl = card.querySelector('.device-meta');
        var iconEl = card.querySelector('.device-icon');

        var name = device.name || device.ip || 'Unknown Device';
        var displayText = device.ip ? name + ' / ' + device.ip : name;

        if (nameEl) nameEl.textContent = displayText;
        if (metaEl) metaEl.textContent = device.os || 'Unknown';
        if (iconEl) iconEl.textContent = getOsIcon(device.os);
    }

    /**
     * 更新设备数量显示
     * @param {number} count
     */
    function updateDeviceCount(count) {
        var el = document.getElementById('deviceCount');
        if (el) {
            el.textContent = count > 0 ? count + ' 台设备在线' : '';
        }
    }

    /**
     * 更新设备选中状态
     * @param {string} deviceId
     * @param {boolean} selected
     */
    function updateDeviceSelection(deviceId, selected) {
        var card = document.querySelector('.device-card[data-device-id="' + deviceId + '"]');
        if (card) {
            if (selected) {
                card.classList.add('selected');
            } else {
                card.classList.remove('selected');
            }
        }
    }

    /**
     * 清除所有设备选中状态
     */
    function clearDeviceSelection() {
        document.querySelectorAll('.device-card.selected').forEach(function (card) {
            card.classList.remove('selected');
        });
    }

    /**
     * 更新 FAB 按钮可见性
     * @param {number} selectedCount - 选中的设备数量
     */
    function updateFabVisibility(selectedCount) {
        var fab = document.getElementById('sendFab');
        if (!fab) return;

        if (selectedCount > 0) {
            fab.classList.add('visible');
            fab.classList.remove('hidden');
            // 更新 FAB 提示文字
            fab.setAttribute('title', '发送文件到 ' + selectedCount + ' 台设备');
        } else {
            fab.classList.remove('visible');
            fab.classList.add('hidden');
        }
    }

    // ===================== 传输任务卡片渲染 =====================

    /**
     * 渲染传输任务卡片
     * @param {TransferState} state
     */
    function renderTransferCard(state) {
        var list = document.getElementById('transferList');
        var section = document.getElementById('transferSection');
        if (!list) return;

        // 显示传输区域
        if (section) {
            section.style.display = 'block';
        }

        var card = document.createElement('div');
        card.className = 'transfer-card';
        card.setAttribute('data-transfer-id', state.fileId);

        var direction = state.direction === 'send' ? '发送' : '接收';
        var directionClass = state.direction === 'send' ? 'send' : 'receive';
        var peerName = getPeerName(state.targetId);

        card.innerHTML =
            '<div class="transfer-header">' +
            '  <span class="transfer-direction ' + directionClass + '">' + direction + '</span>' +
            '  <span class="transfer-peer">' + escapeHtml(peerName) + '</span>' +
            '  <span class="transfer-status">等待中...</span>' +
            '</div>' +
            '<div class="transfer-file-info">' +
            '  <span class="transfer-file-name">' + escapeHtml(state.fileName) + '</span>' +
            '  <span class="transfer-progress-text">' + Flit.transfer.formatSize(0) + ' / ' + Flit.transfer.formatSize(state.fileSize) + '</span>' +
            '</div>' +
            '<div class="transfer-progress-bar">' +
            '  <div class="transfer-progress-fill" style="width: 0%"></div>' +
            '</div>' +
            '<div class="transfer-stats">' +
            '  <span class="transfer-speed">--</span>' +
            '  <span class="transfer-remaining">剩余 --</span>' +
            '</div>' +
            '<button class="transfer-cancel-btn" title="取消传输">\u2715</button>';

        // 绑定取消按钮事件
        var cancelBtn = card.querySelector('.transfer-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                Flit.transfer.cancelTransfer(state.fileId);
            });
        }

        // 添加到列表顶部
        list.insertBefore(card, list.firstChild);

        // 入场动画
        requestAnimationFrame(function () {
            card.classList.add('entering');
        });
    }

    /**
     * 更新传输任务卡片
     * @param {TransferState} state
     */
    function updateTransferCard(state) {
        var card = document.querySelector('.transfer-card[data-transfer-id="' + state.fileId + '"]');
        if (!card) return;

        // 更新状态文字
        var statusEl = card.querySelector('.transfer-status');
        if (statusEl) {
            statusEl.textContent = getStatusText(state.status);
            statusEl.className = 'transfer-status status-' + state.status;
        }

        // 更新进度文字
        var progressTextEl = card.querySelector('.transfer-progress-text');
        if (progressTextEl) {
            progressTextEl.textContent = Flit.transfer.formatSize(state.transferred) + ' / ' + Flit.transfer.formatSize(state.fileSize);
        }

        // 更新进度条
        var fillEl = card.querySelector('.transfer-progress-fill');
        if (fillEl) {
            var percent = state.fileSize > 0 ? (state.transferred / state.fileSize * 100) : 0;
            fillEl.style.width = Math.min(percent, 100) + '%';
        }

        // 更新速率
        var speedEl = card.querySelector('.transfer-speed');
        if (speedEl) {
            speedEl.textContent = Flit.transfer.formatSpeed(state.speed);
        }

        // 更新剩余时间
        var remainingEl = card.querySelector('.transfer-remaining');
        if (remainingEl) {
            remainingEl.textContent = Flit.transfer.formatTime(state.remainingTime);
        }

        // 完成或失败时隐藏取消按钮，添加完成动画
        if (state.status === 'completed') {
            card.classList.add('completed');
            var cancelBtn = card.querySelector('.transfer-cancel-btn');
            if (cancelBtn) cancelBtn.style.display = 'none';
        } else if (state.status === 'failed' || state.status === 'cancelled') {
            card.classList.add('failed');
            var cancelBtn2 = card.querySelector('.transfer-cancel-btn');
            if (cancelBtn2) cancelBtn2.style.display = 'none';
        }
    }

    /**
     * 获取传输状态文字
     * @param {string} status
     * @returns {string}
     */
    function getStatusText(status) {
        switch (status) {
            case 'pending': return '等待中...';
            case 'transferring': return '传输中';
            case 'completed': return '已完成';
            case 'failed': return '失败';
            case 'cancelled': return '已取消';
            default: return status;
        }
    }

    /**
     * 清除已完成的传输任务
     */
    function clearCompletedTransfers() {
        var list = document.getElementById('transferList');
        if (!list) return;

        var cards = list.querySelectorAll('.transfer-card.completed, .transfer-card.failed');
        cards.forEach(function (card) {
            var fileId = card.getAttribute('data-transfer-id');
            card.classList.add('removing');
            card.addEventListener('animationend', function () {
                if (card.parentNode) {
                    card.parentNode.removeChild(card);
                }
                // 从 transfers map 中移除
                Flit.transfer.transfers.delete(fileId);
            });
        });

        // 检查是否还有传输任务
        setTimeout(function () {
            var remaining = list.querySelectorAll('.transfer-card');
            var section = document.getElementById('transferSection');
            if (remaining.length === 0 && section) {
                section.style.display = 'none';
            }
        }, 500);
    }

    // ===================== Toast 消息 =====================

    /**
     * 显示 Toast 消息
     * @param {string} message - 消息文本
     * @param {string} type - 'success' | 'error' | 'warning' | 'info'
     * @param {number} duration - 显示时间（毫秒），默认 3000
     */
    function toast(message, type, duration) {
        type = type || 'info';
        duration = duration || 3000;

        var container = document.getElementById('toastContainer');
        if (!container) {
            // 如果没有 toast 容器，创建一个
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        var toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.textContent = message;

        container.appendChild(toast);

        // 入场动画
        requestAnimationFrame(function () {
            toast.classList.add('show');
        });

        // 自动消失
        setTimeout(function () {
            toast.classList.remove('show');
            toast.classList.add('hide');
            toast.addEventListener('animationend', function () {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            });
            // 安全兜底：如果动画未触发，直接移除
            setTimeout(function () {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 1000);
        }, duration);
    }

    // ===================== 接收请求弹窗 =====================

    /**
     * 显示接收文件请求弹窗
     * @param {Object} data - {to, from, files: [{name, size}]}
     */
    function showReceiveRequestDialog(data) {
        var dialog = document.getElementById('sendRequestDialog');
        if (!dialog) return;

        // 存储发送方 ID
        dialog.setAttribute('data-from-id', data.from);

        // 发送方信息
        var senderInfoEl = document.getElementById('senderInfo');
        if (senderInfoEl) {
            var device = Flit.getDevice(data.from);
            var senderName = device ? (device.name || device.ip || 'Unknown') : data.from;
            senderInfoEl.textContent = senderName + ' 想向你发送文件';
        }

        // 文件列表
        var fileListEl = document.getElementById('requestFileList');
        if (fileListEl) {
            fileListEl.innerHTML = '';
            data.files.forEach(function (file) {
                var item = document.createElement('div');
                item.className = 'request-file-item';
                item.innerHTML =
                    '<span class="request-file-name">' + escapeHtml(file.name) + '</span>' +
                    '<span class="request-file-size">' + Flit.transfer.formatSize(file.size) + '</span>';
                fileListEl.appendChild(item);
            });
        }

        // 总大小
        var totalSizeEl = document.getElementById('requestTotalSize');
        if (totalSizeEl) {
            var totalSize = data.files.reduce(function (sum, f) { return sum + f.size; }, 0);
            totalSizeEl.textContent = '共 ' + data.files.length + ' 个文件，' + Flit.transfer.formatSize(totalSize);
        }

        // 显示弹窗
        dialog.showModal();
    }

    /**
     * 隐藏接收请求弹窗
     */
    function hideReceiveRequestDialog() {
        var dialog = document.getElementById('sendRequestDialog');
        if (dialog) {
            dialog.close();
            dialog.removeAttribute('data-from-id');
        }
    }

    // ===================== 工具函数 =====================

    /**
     * 获取对端设备名称
     * @param {string} deviceId
     * @returns {string}
     */
    function getPeerName(deviceId) {
        var device = Flit.getDevice(deviceId);
        if (device) {
            return device.name || device.ip || deviceId;
        }
        return deviceId;
    }

    /**
     * HTML 转义
     * @param {string} str
     * @returns {string}
     */
    function escapeHtml(str) {
        if (!str) return '';
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // ===================== 暴露到全局 =====================

    window.Flit = window.Flit || {};
    window.Flit.ui = {
        renderDeviceGrid: renderDeviceGrid,
        updateDeviceCount: updateDeviceCount,
        updateDeviceSelection: updateDeviceSelection,
        clearDeviceSelection: clearDeviceSelection,
        updateFabVisibility: updateFabVisibility,
        renderTransferCard: renderTransferCard,
        updateTransferCard: updateTransferCard,
        clearCompletedTransfers: clearCompletedTransfers,
        toast: toast,
        showReceiveRequestDialog: showReceiveRequestDialog,
        hideReceiveRequestDialog: hideReceiveRequestDialog
    };

})();
