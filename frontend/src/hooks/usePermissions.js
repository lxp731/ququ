import { useState, useCallback } from 'react';

export const usePermissions = (showAlert) => {
  const [micGranted, setMicGranted] = useState(false);
  const [a11yGranted, setA11yGranted] = useState(false);

  const requestMic = useCallback(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicGranted(true);
      showAlert?.({ title: '✅ 麦克风权限正常', description: '可以开始语音录制了。' });
    } catch (err) {
      setMicGranted(false);
      showAlert?.({ title: '❌ 需要麦克风权限', description: '请授予麦克风权限以使用语音转录功能。' });
    }
  }, [showAlert]);

  const testA11y = useCallback(async () => {
    try {
      await window.electronAPI?.pasteText('蛐蛐权限测试');
      setA11yGranted(true);
      showAlert?.({ title: '✅ 辅助功能权限正常', description: '自动粘贴功能正常工作。' });
    } catch (err) {
      setA11yGranted(false);
      showAlert?.({ title: '❌ 需要辅助功能权限', description: '请在系统设置中授予权限以启用自动粘贴。' });
    }
  }, [showAlert]);

  return {
    micPermissionGranted: micGranted,
    accessibilityPermissionGranted: a11yGranted,
    requestMicPermission: requestMic,
    testAccessibilityPermission: testA11y,
    setMicPermissionGranted: setMicGranted,
    setAccessibilityPermissionGranted: setA11yGranted,
  };
};
