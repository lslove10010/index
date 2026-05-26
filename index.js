const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');

// 加载 .env
function loadEnv() {
    try {
        const env = fs.readFileSync('.env', 'utf8');
        env.split('\n').forEach(line => {
            if (line.trim() && !line.startsWith('#') && line.includes('=')) {
                const [k, ...v] = line.split('=');
                process.env[k.trim()] = v.join('=').trim().replace(/"/g, '');
            }
        });
    } catch (e) {}
}
loadEnv();

// ====================== 配置 ======================
const config = {
    UUID: process.env.UUID || '',
    DOMAIN: process.env.DOMAIN || '',
    FAKE_DOMAIN: process.env.FAKE_DOMAIN || 'www.visakorea.com',
    PORT: process.env.PORT || 3000,
    REMARKS: process.env.REMARKS || '晚风节点',
    SUB_PATH: process.env.SUB_PATH?.replace(/\//g, '') || 'sub',

    get wsPath() {
        return '/' + this.UUID.replace(/-/g, '').slice(0, 8);
    }
};

// ==========================================
// 哪吒 Agent（自动识别架构 + 当前路径 nz 文件夹）
// ==========================================
function startNezha() {
    // 使用当前文件所在目录下的 nz 文件夹
    const nzDir = path.join(__dirname, 'nz');
    const ymlPath = path.join(nzDir, 'config.yml');
    const agentPath = path.join(nzDir, 'nezha-agent');
    const logPath = path.join(nzDir, 'nezha.log');

    console.log('🚀 初始化哪吒Agent（最新版）');
    console.log(`📁 工作目录: ${nzDir}`);

    // 创建 nz 目录（如果不存在）
    if (!fs.existsSync(nzDir)) {
        fs.mkdirSync(nzDir, { recursive: true });
        console.log('✅ 创建 nz 目录');
    }

    // 检查配置文件和可执行文件状态
    const hasConfig = fs.existsSync(ymlPath);
    const hasAgent = fs.existsSync(agentPath);

    if (hasConfig && hasAgent) {
        // 两者都存在，直接启动
        console.log('✅ 发现已有配置文件和Agent，直接启动');
        runAgent();
        return;
    }

    if (hasConfig && !hasAgent) {
        // 有配置但缺少Agent，只需下载
        console.log('⚠️ 发现配置文件但缺少Agent，开始下载');
        detectArchAndDownload();
        return;
    }

    // 首次生成固定UUID配置文件
    const fixedUUID = crypto.randomUUID();
    const configYml = `client_secret: guOB7re9nLpsyXgUuu8ukoBkOXrhVeR2
debug: true
disable_auto_update: false
disable_command_execute: false
disable_force_update: false
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: false
ip_report_period: 1800
report_delay: 3
self_update_period: 0
server: nz.gl.edu.eu.org:443
skip_connection_count: false
skip_procs_count: false
temperature: false
tls: true
use_atomgit_to_upgrade: false
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${fixedUUID}
`;

    fs.writeFileSync(ymlPath, configYml, 'utf8');
    console.log('✅ 首次生成固定UUID配置文件');
    detectArchAndDownload();

    function detectArchAndDownload() {
        // 自动识别系统架构
        exec('uname -m', (err, stdout) => {
            if (err) {
                console.log('⚠️ 无法识别架构，默认使用 amd64');
                downloadAgent('amd64');
                return;
            }
            const arch = stdout.trim();
            const archMap = {
                'x86_64': 'amd64',
                'amd64': 'amd64',
                'aarch64': 'arm64',
                'arm64': 'arm64',
                'armv7l': 'arm',
                'armv6l': 'arm',
                'armv5tel': 'arm',
                'i686': '386',
                'i386': '386',
            };
            const targetArch = archMap[arch] || 'amd64';
            console.log(`🔧 检测到架构: ${arch} -> 下载 ${targetArch} 版本`);
            downloadAgent(targetArch);
        });
    }

    function downloadAgent(targetArch) {
        const downloadUrl = `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${targetArch}.zip`;
        const zipPath = path.join(nzDir, 'nezha-agent.zip');

        console.log(`⬇️ 开始下载: ${downloadUrl}`);

        // 使用 Node.js 原生 https 模块下载，不依赖 curl/wget
        const https = require('https');
        const http = require('http');
        const { URL } = require('url');
        const file = fs.createWriteStream(zipPath);

        // 递归下载，自动处理多层重定向
        function doDownload(currentUrl, redirectCount = 0) {
            if (redirectCount > 5) {
                console.log('❌ 重定向次数超过限制');
                file.destroy();
                return;
            }

            const parsedUrl = new URL(currentUrl);
            const client = parsedUrl.protocol === 'https:' ? https : http;

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port,
                path: parsedUrl.pathname + parsedUrl.search,
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'identity',
                    'Connection': 'keep-alive'
                }
            };

            client.get(options, (response) => {
                // 处理重定向 (301/302/307/308)
                if ([301, 302, 307, 308].includes(response.statusCode)) {
                    let redirectUrl = response.headers.location;
                    if (!redirectUrl) {
                        console.log(`❌ HTTP ${response.statusCode} 但没有 Location 头`);
                        file.destroy();
                        return;
                    }

                    // 处理相对路径
                    if (redirectUrl.startsWith('/')) {
                        redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
                    } else if (!redirectUrl.startsWith('http')) {
                        redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}/${redirectUrl}`;
                    }

                    console.log(`🔄 跟随重定向 (${redirectCount + 1}/5): ${redirectUrl.substring(0, 80)}...`);
                    doDownload(redirectUrl, redirectCount + 1);
                    return;
                }

                // 处理成功
                if (response.statusCode === 200) {
                    handleDownloadResponse(response, zipPath, file);
                    return;
                }

                // 其他错误
                console.log(`❌ HTTP 错误: ${response.statusCode}`);
                file.destroy();
            }).on('error', (err) => {
                console.log('❌ 下载失败:', err.message);
                console.log(`   URL: ${currentUrl}`);
                file.destroy();
            });
        }

        doDownload(downloadUrl);

        function handleDownloadResponse(response, zipPath, file) {
            const totalSize = parseInt(response.headers['content-length'] || '0');
            let downloaded = 0;
            let lastPercent = -1;

            response.pipe(file);

            response.on('data', (chunk) => {
                downloaded += chunk.length;
                if (totalSize > 0) {
                    const percent = Math.round((downloaded / totalSize) * 100);
                    if (percent !== lastPercent && percent % 10 === 0) {
                        lastPercent = percent;
                        console.log(`📥 下载进度: ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(totalSize / 1024 / 1024).toFixed(1)}MB)`);
                    }
                }
            });

            response.on('end', () => {
                if (totalSize === 0) {
                    console.log(`📥 已下载: ${downloaded} bytes`);
                }
            });

            file.on('finish', () => {
                file.close();
                console.log(`✅ 下载完成: ${downloaded} bytes`);
                extractAndRun(zipPath);
            });

            file.on('error', (err) => {
                console.log('❌ 文件写入失败:', err.message);
                fs.unlink(zipPath, () => {});
            });
        }

        function extractAndRun(zipPath) {
            // 尝试多种解压方式
            const extractCmds = [
                `cd "${nzDir}" && unzip -o nezha-agent.zip`,           // 标准 unzip
                `cd "${nzDir}" && busybox unzip -o nezha-agent.zip`,   // busybox
                `cd "${nzDir}" && python3 -c "import zipfile; zipfile.ZipFile('nezha-agent.zip').extractall('.')"`,  // python
                `cd "${nzDir}" && python -c "import zipfile; zipfile.ZipFile('nezha-agent.zip').extractall('.')"`,   // python2
            ];

            tryExtract(0);

            function tryExtract(index) {
                if (index >= extractCmds.length) {
                    console.log('❌ 所有解压方式都失败了');
                    console.log('   请手动解压 nz/nezha-agent.zip 后重启服务');
                    return;
                }

                const cmd = extractCmds[index];
                console.log(`📦 尝试解压 (${index + 1}/${extractCmds.length})...`);

                exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
                    if (err) {
                        // 这个命令不可用，尝试下一个
                        tryExtract(index + 1);
                        return;
                    }

                    console.log('✅ 解压完成');

                    // 检查 nezha-agent 是否存在
                    if (!fs.existsSync(agentPath)) {
                        console.log('❌ 解压后找不到 nezha-agent 可执行文件');
                        console.log(`   期望路径: ${agentPath}`);
                        try {
                            const files = fs.readdirSync(nzDir);
                            console.log(`   nz 目录内容: ${files.join(', ')}`);
                        } catch (e) {}
                        return;
                    }

                    // 加执行权限
                    fs.chmodSync(agentPath, 0o755);
                    console.log('✅ 已赋予执行权限');

                    // 启动
                    // 删除下载的 zip 文件
            try {
                fs.unlinkSync(zipPath);
                console.log('🗑️ 已删除 nezha-agent.zip');
            } catch (e) {
                // 忽略删除失败
            }

            setTimeout(runAgent, 1000);
                });
            }
        }
    }

    function runAgent() {
        exec(`"${agentPath}" -c "${ymlPath}" > "${logPath}" 2>&1 &`, (err) => {
            if (err) console.log('⚠️ 启动哪吒时出现错误:', err.message);
            else console.log('✅ 哪吒Agent已后台启动');
        });
    }
}

function getPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TT随笔 | 生活、摄影与日常记录</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css">
    <style>
        .hero-bg {
            background: linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.65)), url('https://picsum.photos/id/1015/2000/1200') center/cover;
        }
        .photo-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 16px;
        }
        .photo-card:hover { transform: scale(1.05); }
    </style>
</head>
<body class="bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors">

    <!-- 导航栏 -->
    <nav class="bg-white/80 dark:bg-zinc-900/80 backdrop-blur-lg border-b border-zinc-200 dark:border-zinc-800 sticky top-0 z-50">
        <div class="max-w-6xl mx-auto px-6 py-5 flex justify-between items-center">
            <div class="flex items-center gap-3">
                <div class="w-9 h-9 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center text-white text-2xl">🌬️</div>
                <h1 class="text-2xl font-semibold">TT随笔</h1>
            </div>
            <div class="hidden md:flex gap-8 text-sm font-medium">
                <a href="#" class="hover:text-blue-500 transition">首页</a>
                <a href="#" class="hover:text-blue-500 transition">文章</a>
                <a href="#" class="hover:text-blue-500 transition">摄影</a>
                <a href="#" class="hover:text-blue-500 transition">关于我</a>
            </div>
            <button id="theme-toggle" class="w-10 h-10 rounded-2xl hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center">
                <i class="fa-solid fa-moon text-xl"></i>
            </button>
        </div>
    </nav>

    <!-- Hero -->
    <header class="hero-bg h-[560px] flex items-center text-white">
        <div class="max-w-4xl mx-auto px-6 text-center">
            <h2 class="text-5xl md:text-6xl font-bold mb-6">把日常过成诗</h2>
            <p class="text-xl opacity-90">记录生活中的温柔与美好</p>
        </div>
    </header>

    <div class="max-w-6xl mx-auto px-6 py-16">
        <!-- 文章 -->
        <section class="mb-20">
            <h3 class="text-3xl font-semibold mb-8">最新随笔</h3>
            <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                <!-- 文章卡片1 -->
                <div class="bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow hover:shadow-xl transition">
                    <img src="https://picsum.photos/id/1015/600/400" class="w-full h-56 object-cover">
                    <div class="p-6">
                        <div class="text-xs text-zinc-500 dark:text-zinc-400">2025.05.18 · 生活</div>
                        <h4 class="font-semibold text-xl mt-2 mb-3">雨后清晨的温柔</h4>
                        <p class="text-zinc-600 dark:text-zinc-400 line-clamp-3">昨夜一场大雨，把城市洗得干干净净...</p>
                    </div>
                </div>
                <!-- 文章卡片2、3 类似，可自行复制修改 -->
                <div class="bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow hover:shadow-xl transition">
                    <img src="https://picsum.photos/id/201/600/400" class="w-full h-56 object-cover">
                    <div class="p-6">
                        <div class="text-xs text-zinc-500 dark:text-zinc-400">2025.05.15 · 摄影</div>
                        <h4 class="font-semibold text-xl mt-2 mb-3">城市黄昏的最后一缕光</h4>
                        <p class="text-zinc-600 dark:text-zinc-400 line-clamp-3">在高楼拍下的绝美日落...</p>
                    </div>
                </div>
                <div class="bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow hover:shadow-xl transition">
                    <img src="https://picsum.photos/id/870/600/400" class="w-full h-56 object-cover">
                    <div class="p-6">
                        <div class="text-xs text-zinc-500 dark:text-zinc-400">2025.05.12 · 随想</div>
                        <h4 class="font-semibold text-xl mt-2 mb-3">成年人的体面</h4>
                        <p class="text-zinc-600 dark:text-zinc-400 line-clamp-3">学会把情绪藏好，继续向前走...</p>
                    </div>
                </div>
            </div>
        </section>

        <!-- 照片墙 -->
        <section>
            <h3 class="text-3xl font-semibold mb-8">摄影瞬间</h3>
            <div class="photo-grid">
                <div class="photo-card bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow"><img src="https://picsum.photos/id/1015/800/1000" class="w-full"></div>
                <div class="photo-card bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow"><img src="https://picsum.photos/id/201/800/600" class="w-full"></div>
                <div class="photo-card bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow"><img src="https://picsum.photos/id/870/800/900" class="w-full"></div>
                <div class="photo-card bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow"><img src="https://picsum.photos/id/133/800/700" class="w-full"></div>
                <div class="photo-card bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow"><img src="https://picsum.photos/id/251/800/1100" class="w-full"></div>
                <div class="photo-card bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow"><img src="https://picsum.photos/id/1016/800/650" class="w-full"></div>
            </div>
        </section>
    </div>

    <footer class="bg-zinc-900 text-zinc-400 py-12 text-center">
        <div class="max-w-6xl mx-auto px-6">
            © 2025 TT随笔 • 记录生活，感受当下
        </div>
    </footer>

    <script>
        const toggle = document.getElementById('theme-toggle');
        const html = document.documentElement;

        function setTheme(dark) {
            if (dark) {
                html.classList.add('dark');
                toggle.innerHTML = '<i class="fa-solid fa-sun text-xl"></i>';
            } else {
                html.classList.remove('dark');
                toggle.innerHTML = '<i class="fa-solid fa-moon text-xl"></i>';
            }
            localStorage.setItem('theme', dark ? 'dark' : 'light');
        }

        if (localStorage.getItem('theme') === 'dark' || 
           (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            setTheme(true);
        }

        toggle.addEventListener('click', () => setTheme(!html.classList.contains('dark')));
    </script>
</body>
</html>`;
}

// ====================== HTTP 服务 ======================
const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;

    if (p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getPage());
        return;
    }

    if (p === '/' + config.SUB_PATH) {
        const link = `vless://${config.UUID}@${config.FAKE_DOMAIN}:443?encryption=none&security=tls&sni=${config.DOMAIN}&fp=chrome&type=ws&host=${config.DOMAIN}&path=${encodeURIComponent(config.wsPath)}#${encodeURIComponent(config.REMARKS)}`;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(Buffer.from(link).toString('base64'));
        return;
    }

    res.writeHead(404);
    res.end('404 Not Found');
});

// ====================== VLESS WS 代理 ======================
const uuidBin = Buffer.from(config.UUID.replace(/-/g, ''), 'hex');
const wss = new WebSocketServer({ server });

// VLESS 握手解析（支持 IPv4、域名、IPv6）
function parseVlessHandshake(buf) {
  let offset = 0;
  const version = buf.readUInt8(offset++);
  const id = buf.subarray(offset, offset + 16); offset += 16;
  const addonsLen = buf.readUInt8(offset++); offset += addonsLen;
  const command = buf.readUInt8(offset++);
  const port = buf.readUInt16BE(offset); offset += 2;
  const addrType = buf.readUInt8(offset++);
  let host;
  switch (addrType) {
    case 1: // IPv4
      host = Array.from(buf.subarray(offset, offset + 4)).join('.');
      offset += 4;
      break;
    case 2: // 域名
      const len = buf.readUInt8(offset++);
      host = buf.subarray(offset, offset + len).toString();
      offset += len;
      break;
    case 3: // IPv6
      const ipv6Bytes = buf.subarray(offset, offset + 16);
      host = Array.from(ipv6Bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .reduce((acc, cur, idx) => acc + (idx % 2 === 1 ? ':' + cur : cur), '')
        .replace(/(^|:)0+(:|$)/g, '$1$2');
      if (host.startsWith(':')) host = '0' + host;
      if (host.endsWith(':')) host += '0';
      offset += 16;
      break;
    default:
      throw new Error('Unsupported address type');
  }
  return { version, id, host, port, offset };
}

wss.on('connection', (ws) => {
  ws.once('message', (data) => {
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const { version, id, host, port, offset } = parseVlessHandshake(buf);

      if (!id.equals(uuidBin)) {
        ws.close(1008, 'Invalid UUID');
        return;
      }

      ws.send(Buffer.from([version, 0]));

      const duplex = require('ws').createWebSocketStream(ws, {
        allowHalfOpen: true,
      });

      const socket = net.connect({ host, port }, () => {
        socket.write(buf.slice(offset));
        duplex.pipe(socket).pipe(duplex);
      });

      const cleanup = () => {
        socket.destroy();
        ws.terminate();
      };

      socket.on('error', cleanup);
      duplex.on('error', cleanup);
      socket.on('close', () => ws.terminate());
      duplex.on('close', () => socket.destroy());

    } catch {
      ws.close(1002, 'Protocol error');
    }
  });
});
// ====================== 启动服务 ======================
startNezha();   // ← 哪吒启动

server.listen(config.PORT, '::', () => {
    console.log(`✅ 服务启动成功 | 端口: ${config.PORT}`);
    console.log(`🔗 订阅地址: http(s)://你的域名/${config.SUB_PATH}`);
    console.log(`🧩 WS路径: ${config.wsPath}`);
});
