const fs = require("fs");

fs.readFile("web/loader.js", "utf-8", (err, data) => {
    if (err) {
        console.error("读取文件出错:", err);
        return;
    }
    class URLSearchParams {
        constructor(query) {
            this.query = query;
        }
        get(key) {
            return "1.8.39";
        }
    }
    const window = { location: { search: "" } };
    const document = { write: () => {} };
    eval(data);
    const verData = window.verData;
    Object.keys(verData).forEach(ver => {
        const { jsMain, jsVendors, jsBase, cssMain } = verData[ver];
        const paths = [
            `/static/js/main.${jsMain}.js`,
            `/static/js/main-vendors.${jsVendors}.js`,
            `/static/js/base.${jsBase}.js`,
            `/static/css/main.${cssMain}.css`,
        ];
        paths.forEach(path => {
            const localPath = './web' + path;
            if (!fs.existsSync(localPath)) {
                console.log(`缺失 ${path}`);
                const file = fs.createWriteStream(localPath);
                const request = require("https").get(`https://creation.bcmcdn.com/neko/web/release${path}`, function(response) {
                    response.pipe(file);
                    file.on("finish", function() {
                        file.close();
                        console.log(`${path} 下载完成`);
                    });
                });
            }
        })
    });
});
