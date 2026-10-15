// Translate only messages supplied by the API. Account names and other user
// content must never be passed through this function.
export const serverMessages = Object.freeze({
  '账号名称须为 1–60 个字符。': 'Account names must contain 1–60 characters.',
  'Codex 返回了无效的登录地址，请更新 Codex CLI 后重试。': 'Codex returned an invalid sign-in URL. Update Codex CLI and try again.',
  '账号不存在。': 'Account not found.',
  '最多管理 100 个账号。': 'You can manage up to 100 accounts.',
  '此账号已在列表中，请保留一条记录，或连接不同账号。': 'This account is already in the list. Keep one entry or connect a different account.',
  'Codex 连接已中断，请刷新或重新登录。': 'The Codex connection was interrupted. Refresh or sign in again.',
  '登录未完成，请重试；也可使用设备验证码登录。': 'Sign-in was not completed. Try again or sign in with a device code.',
  '桌面账号正在切换，请稍后操作。': 'The desktop account is being switched. Please wait before making changes.',
  '不支持的登录方式。': 'This sign-in method is not supported.',
  '请先完成或取消当前账号的登录。': 'Complete or cancel the current sign-in first.',
  '登录已取消。': 'Sign-in was canceled.',
  '登录已超时，请重新发起登录。': 'Sign-in timed out. Please start again.',
  '无法启动登录。请确认 Codex CLI 可用，或改用设备验证码登录。': 'Could not start sign-in. Check that Codex CLI is available or use a device code.',
  '无法启动登录。请确认 Codex CLI 已安装，浏览器登录回调端口未被占用；也可尝试设备验证码登录。': 'Could not start sign-in. Check that Codex CLI is installed and the browser sign-in callback port is available, or try a device code.',
  '登录已失效，请重新登录。': 'Your sign-in has expired. Please sign in again.',
  '此账号不是 ChatGPT 登录，无法读取订阅额度。': 'This account is not signed in with ChatGPT, so subscription usage cannot be read.',
  '读取额度失败，已保留上次数据。请检查网络后刷新。': 'Could not read usage. Your previous data has been kept. Check your connection and refresh.',

  '请求必须使用 application/json。': 'Requests must use application/json.',
  '请求内容过大。': 'The request is too large.',
  'JSON 请求格式错误。': 'The request contains invalid JSON.',
  '仅允许通过本机地址访问。': 'Access is only allowed from a local address.',
  '不允许跨站请求。': 'Cross-site requests are not allowed.',
  '不允许跨域请求。': 'Cross-origin requests are not allowed.',
  '修改操作必须从本机管理页面发起。': 'Changes must be made from the local management page.',
  '不支持的请求方法。': 'This request method is not supported.',
  '桌面切换未启用。': 'Desktop account switching is not enabled.',
  '接口不存在。': 'API endpoint not found.',
  '文件不存在。': 'File not found.',
  '请求路径无效。': 'The request path is invalid.',
  '操作失败，请稍后重试。': 'The operation failed. Please try again later.',

  '登录配置存在自定义或分组设置，请在 Codex 内完成切换。': 'The sign-in configuration contains custom or grouped settings. Switch accounts in Codex.',
  '检测到受管理的 Codex 配置，请使用客户端的登录功能。': 'A managed Codex configuration was detected. Use the app’s sign-in feature.',
  '当前凭据存储为 keyring，暂不支持网页切换。': 'Credentials are stored using keyring. Switching from this page is not supported.',
  '当前凭据存储为 auto，暂不支持网页切换。': 'Credentials are stored using auto. Switching from this page is not supported.',
  '当前凭据存储为 ephemeral，暂不支持网页切换。': 'Credentials are stored using ephemeral. Switching from this page is not supported.',
  '当前凭据存储为 自定义方式，暂不支持网页切换。': 'Credentials use a custom storage method. Switching from this page is not supported.',
  '当前配置限制为 API Key 登录，不能切换订阅账号。': 'The current configuration only allows API key sign-in. Subscription accounts cannot be switched.',
  '无法安全读取本机登录配置，请检查目录和文件权限。': 'The local sign-in configuration could not be read safely. Check the directory and file permissions.',

  '桌面账号切换目前仅支持 macOS。': 'Desktop account switching is currently available only on macOS.',
  '未找到受支持的 Codex 桌面应用，请将应用安装到 Applications 文件夹。': 'No supported Codex desktop app was found. Install the app in the Applications folder.',
  '无法确认桌面进程状态，暂时不能切换。': 'The desktop process status could not be verified. Switching is temporarily unavailable.',
  '检测到多个 Codex 桌面实例，请先仅保留一个。': 'Multiple Codex desktop instances were detected. Close all but one before switching.',
  '桌面客户端使用了自定义配置或登录存储参数，暂时不能安全切换。': 'The desktop app uses custom configuration or credential storage options. It cannot be switched safely.',
  '请先关闭 VS Code 中的 Codex 及其他 Codex CLI 会话，再切换桌面账号。': 'Close Codex in VS Code and any other Codex CLI sessions before switching the desktop account.',
  '上次切换被中断，请检查客户端账号；原登录备份仍保留。': 'The previous switch was interrupted. Check the account in the app. The original sign-in backup has been kept.',
  '切换进程意外退出，请检查客户端；登录备份仍保留，可尝试恢复。': 'The switching process exited unexpectedly. Check the app. The sign-in backup has been kept and can be restored.',
  '桌面账号正在切换，请等待完成。': 'The desktop account is being switched. Please wait for it to finish.',
  '目前仅支持 macOS 桌面客户端。': 'Only the macOS desktop app is currently supported.',
  '未检测到受支持的 Codex 桌面客户端。': 'No supported Codex desktop app was detected.',
  '检测到自定义 CODEX_HOME，请使用客户端自带的登录功能。': 'A custom CODEX_HOME was detected. Use the app’s sign-in feature.',
  '无法安全读取桌面登录文件，请检查权限或符号链接。': 'The desktop sign-in file could not be read safely. Check permissions and symbolic links.',
  '请先关闭其他 Codex CLI 或 VS Code Codex 扩展，再切换账号。': 'Close other Codex CLI sessions and the Codex extension in VS Code before switching accounts.',
  '请先完成或取消正在进行的账号授权。': 'Complete or cancel the current account authorization first.',
  '正在切换桌面账号，请等待完成。': 'The desktop account is being switched. Please wait for it to finish.',
  '请先确认切换并重启桌面客户端。': 'Confirm that you want to switch accounts and restart the desktop app first.',
  '已有切换请求正在准备。': 'Another account switch is being prepared.',
  '该账号已是桌面保存的当前登录。': 'This account is already saved as the current desktop sign-in.',
  '请先成功读取该账号额度，再进行切换。': 'Refresh this account’s usage successfully before switching to it.',
  '请先完成或取消账号授权。': 'Complete or cancel account authorization first.',
  '没有可用的登录凭据，请重新连接账号。': 'No usable sign-in credentials were found. Reconnect the account.',
  '所选账号不属于客户端配置要求的工作区。': 'The selected account does not belong to the workspace required by the app configuration.',
  '客户端状态已变化，请刷新后重试。': 'The app’s state has changed. Refresh and try again.',
  '当前桌面使用的登录方式无法安全识别，请在客户端内切换。': 'The current desktop sign-in method could not be identified safely. Switch accounts in the app.',
  '另一个切换任务仍在执行，请稍后刷新。': 'Another account switch is still running. Refresh in a moment.',
  '即将退出客户端并切换登录…': 'Preparing to close the app and switch accounts…',
  '切换任务未能启动，桌面登录未更改。': 'The account switch could not start. The desktop sign-in has not changed.',
  '无法准备桌面切换，请检查登录文件和本地权限。': 'Could not prepare the desktop account switch. Check the sign-in files and local permissions.',
  '正在退出桌面客户端，等待登录文件停止更新…': 'Closing the desktop app and waiting for sign-in file updates to stop…',
  '已备份原登录，正在写入所选账号…': 'The original sign-in is backed up. Saving the selected account…',
  '登录文件已切换，正在重新打开桌面客户端…': 'The sign-in file has been switched. Reopening the desktop app…',
  '已写入登录并重新打开客户端，请在客户端确认账号。': 'The sign-in was saved and the app was reopened. Confirm the account in the app.',
  '客户端重新打开失败。': 'The app could not be reopened.',
  '切换未完成，原桌面登录未被替换。': 'The switch did not complete. The original desktop sign-in was not replaced.',
  '已恢复切换前的登录。': 'The previous sign-in has been restored.',
  '检测到客户端启动或登录文件变化，已保留现状；可使用恢复上次登录。': 'The app started or the sign-in file changed, so the current state was kept. You can use Restore previous sign-in.',
  '原登录备份仍保留，可使用恢复上次登录。': 'The original sign-in backup has been kept. You can use Restore previous sign-in.',
  '请手动打开 Codex。': 'Please open Codex manually.',
});

const messageKeys = Object.keys(serverMessages).sort((a, b) => b.length - a.length);
const untranslatedMessage = 'This server message is not available in English. Switch to Chinese to view the original message.';

export function translateServerMessage(message, language = 'en') {
  if (language === 'zh-CN' || typeof message !== 'string' || !message) return message;
  if (Object.hasOwn(serverMessages, message)) return serverMessages[message];
  if (!/\p{Script=Han}/u.test(message)) return message;

  // A failed desktop job joins several complete messages. Translate only if
  // every part is recognized, so a partial translation never loses its meaning.
  let remaining = message;
  const translated = [];
  while (remaining) {
    const key = messageKeys.find(candidate => remaining.startsWith(candidate));
    if (!key) return untranslatedMessage;
    translated.push(serverMessages[key]);
    remaining = remaining.slice(key.length).trimStart();
  }
  return translated.join(' ');
}
