# -*- coding: utf-8 -*-
"""
云端版：真实平台热榜抓取（抖音 + B站）—— 大学生/年轻人定位版
与本地版逻辑一致，仅路径参数化，供 GitHub Actions 使用。
输出路径通过 --out 指定，默认 data/platform_hot_raw.json（相对当前目录）。
数据源：①抖音热点榜（tophub 实时）②B站全站热门榜（官方API）③B站「大学生活」「考研」近30天按播放搜索（官方API wbi签名）
"""
import json, time, hashlib, re, datetime, random, argparse, os
import urllib.request, urllib.parse

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

def http_get(url, referer=None, timeout=20):
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")

def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()

# ---------------- 抖音（今日热榜聚合） ----------------
def fetch_tophub(node):
    html = http_get(f"https://tophub.today/n/{node}")
    table = re.search(r"<table[^>]*>(.*?)</table>", html, re.S)
    if not table:
        return []
    items = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(1), re.S):
        a = re.search(r'<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', row, re.S)
        if not a:
            continue
        title = strip_tags(a.group(2))
        link = a.group(1)
        heat_txt = ""
        m = re.search(r"([\d,.]+\s*[万亿]|[\d,]+\s*次播放)", row)
        if m:
            heat_txt = m.group(1)
        if title and len(title) > 4:
            items.append({"title": title[:80], "link": link, "heatText": heat_txt})
    return items

def fetch_douyin():
    """抖音：通用热点榜（年轻人向综合热点）"""
    hot = fetch_tophub("K7GdaMgdQy")
    return {"热点榜": hot}

# ---------------- B站 ----------------
MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,
             29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,
             22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]

def wbi_key():
    nav = json.loads(http_get("https://api.bilibili.com/x/web-interface/nav"))
    img = nav["data"]["wbi_img"]["img_url"].split("/")[-1].split(".")[0]
    sub = nav["data"]["wbi_img"]["sub_url"].split("/")[-1].split(".")[0]
    ori = img + sub
    return "".join(ori[i] for i in MIXIN_TAB)[:32]

def wbi_sign(params, key):
    params = dict(params)
    params["wts"] = int(time.time())
    params = dict(sorted(params.items()))
    q = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    params["w_rid"] = hashlib.md5((q + key).encode()).hexdigest()
    return urllib.parse.urlencode(params, quote_via=urllib.parse.quote)

def fetch_bili_rank():
    """B站全站热门排行（rid=0 综合榜，面向全站年轻人）"""
    data = json.loads(http_get(
        "https://api.bilibili.com/x/web-interface/ranking?rid=0&type=all",
        referer="https://www.bilibili.com/v/popular/rank/all"))
    items = []
    if data.get("code") == 0:
        for v in data["data"]["list"]:
            items.append({
                "title": v["title"][:80],
                "author": v.get("author", ""),
                "play": v.get("play", 0),
                "link": f"https://www.bilibili.com/video/{v['bvid']}" if v.get("bvid") else "",
                "pubdate": datetime.datetime.fromtimestamp(v["pubdate"]).strftime("%Y-%m-%d") if v.get("pubdate") else "",
            })
    return items

def fetch_bili_search(keyword, key, days=30):
    end = int(time.time())
    begin = end - days * 86400
    p = {
        "search_type": "video", "keyword": keyword, "order": "click", "page": 1,
        "pubtime_begin_s": begin, "pubtime_end_s": end,
    }
    url = "https://api.bilibili.com/x/web-interface/wbi/search/type?" + wbi_sign(p, key)
    data = json.loads(http_get(url, referer="https://search.bilibili.com"))
    items = []
    if data.get("code") == 0:
        for v in (data["data"].get("result") or []):
            arcurl = v.get("arcurl", "")
            if arcurl.startswith("//"):
                arcurl = "https:" + arcurl
            items.append({
                "title": strip_tags(v["title"])[:80],
                "author": v.get("author", ""),
                "play": v.get("play", 0),
                "danmaku": v.get("video_review", 0),
                "link": arcurl,
                "pubdate": datetime.datetime.fromtimestamp(v["pubdate"]).strftime("%Y-%m-%d") if v.get("pubdate") else "",
            })
    return items

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/platform_hot_raw.json")
    args = ap.parse_args()
    out = args.out
    os.makedirs(os.path.dirname(out), exist_ok=True)

    result = {"fetchedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "sources": {}}

    try:
        dy = fetch_douyin()
        result["sources"]["抖音热点榜"] = dy["热点榜"]
    except Exception as e:
        result["sources"]["抖音热点榜"] = {"error": str(e)}

    try:
        result["sources"]["B站全站热门榜"] = fetch_bili_rank()
    except Exception as e:
        result["sources"]["B站全站热门榜"] = {"error": str(e)}

    try:
        key = wbi_key()
        time.sleep(1)
        result["sources"]["B站搜索_大学生活_近30天按播放"] = fetch_bili_search("大学生活", key)
        time.sleep(random.uniform(1.5, 3))
        result["sources"]["B站搜索_考研_近30天按播放"] = fetch_bili_search("考研", key)
    except Exception as e:
        result["sources"]["B站搜索_大学生活_近30天按播放"] = {"error": str(e)}
        result["sources"]["B站搜索_考研_近30天按播放"] = {"error": str(e)}

    stat = {}
    for k, v in result["sources"].items():
        stat[k] = len(v) if isinstance(v, list) else "FAIL"
    result["stat"] = stat

    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("已保存:", out)
    print("统计:", json.dumps(stat, ensure_ascii=False))

if __name__ == "__main__":
    main()
