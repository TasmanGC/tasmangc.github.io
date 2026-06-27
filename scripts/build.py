#!/usr/bin/env python3
"""
build.py — regenerate blog and technical listing pages.

Run from anywhere inside the repo:
    python scripts/build.py

Rules:
  - posts/template.html and technical/template.html are always skipped.
  - Files whose stem starts with "upcoming_" are included but rendered
    as non-clickable upcoming cards.
  - Post metadata is read from <meta name="post:*"> tags in each file.
  - Cards are injected between <!-- POSTS_START --> and <!-- POSTS_END -->
    sentinels in pages/blog.html and pages/technical.html.
"""

from pathlib import Path
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Metadata extraction
# ---------------------------------------------------------------------------

class _MetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}
        self._in_title = False
        self._title_parts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            name = attrs.get('name', '')
            if name.startswith('post:'):
                self.meta[name[5:]] = attrs.get('content', '')
            elif name == 'description' and '_desc' not in self.meta:
                self.meta['_desc'] = attrs.get('content', '')
        elif tag == 'title':
            self._in_title = True

    def handle_data(self, data):
        if self._in_title:
            self._title_parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False

    def html_title(self):
        raw = ''.join(self._title_parts).strip()
        return raw.split('·')[0].strip() if '·' in raw else raw


def _parse(path: Path) -> dict | None:
    try:
        p = _MetaParser()
        p.feed(path.read_text(encoding='utf-8'))
    except Exception as exc:
        print(f'  WARN could not parse {path.name}: {exc}')
        return None
    m = p.meta
    return {
        'title':    m.get('title')   or p.html_title() or path.stem,
        'date':     m.get('date', ''),
        'sort':     m.get('sort', '0000-00'),
        'readtime': m.get('readtime', ''),
        'image':    m.get('image', ''),
        'excerpt':  m.get('excerpt') or m.get('_desc', ''),
        'tags':     [t.strip() for t in m.get('tags', '').split(',') if t.strip()],
        'upcoming': path.stem.startswith('upcoming_'),
        'href':     '/' + path.relative_to(ROOT).as_posix().replace('\\', '/'),
    }


# ---------------------------------------------------------------------------
# Directory scan
# ---------------------------------------------------------------------------

def scan(directory: str) -> list:
    posts = []
    for path in (ROOT / directory).glob('*.html'):
        if path.name == 'template.html':
            continue
        data = _parse(path)
        if data:
            posts.append(data)

    # Sort: published posts by sort key descending, upcoming always last
    posts.sort(key=lambda p: p['sort'], reverse=True)
    posts.sort(key=lambda p: p['upcoming'])
    return posts


# ---------------------------------------------------------------------------
# Card HTML generation
# ---------------------------------------------------------------------------

def _card(post: dict, fallback_tag: str) -> str:
    tag     = post['tags'][0] if post['tags'] else fallback_tag
    meta    = ' · '.join(filter(None, [post['date'], post['readtime']]))
    img     = post['image'] or '/images/placeholder.jpg'
    excerpt = f'\n            <p>{post["excerpt"]}</p>' if post['excerpt'] else ''

    if post['upcoming']:
        return (
            f'        <div class="article-card upcoming">\n'
            f'          <img class="article-card__image" src="{img}" alt="{post["title"]}">\n'
            f'          <div class="article-card__body">\n'
            f'            <div class="article-card__tag">{tag}</div>\n'
            f'            <h2>{post["title"]}</h2>{excerpt}\n'
            f'            <div class="article-card__meta">{meta or "Coming soon"}</div>\n'
            f'          </div>\n'
            f'        </div>'
        )
    else:
        return (
            f'        <a href="{post["href"]}" class="article-card">\n'
            f'          <img class="article-card__image" src="{img}" alt="{post["title"]}">\n'
            f'          <div class="article-card__body">\n'
            f'            <div class="article-card__tag">{tag}</div>\n'
            f'            <h2>{post["title"]}</h2>{excerpt}\n'
            f'            <div class="article-card__meta">{meta}</div>\n'
            f'          </div>\n'
            f'        </a>'
        )


# ---------------------------------------------------------------------------
# Sentinel injection
# ---------------------------------------------------------------------------

START = '<!-- POSTS_START -->'
END   = '<!-- POSTS_END -->'


def inject(listing: Path, posts: list, fallback_tag: str):
    html = listing.read_text(encoding='utf-8')
    s = html.find(START)
    e = html.find(END)
    if s == -1 or e == -1:
        print(f'  WARN sentinels missing in {listing.name} - skipped')
        return
    cards = '\n\n'.join(_card(p, fallback_tag) for p in posts)
    new_html = html[:s + len(START)] + '\n\n' + cards + '\n\n      ' + html[e:]
    listing.write_text(new_html, encoding='utf-8')
    n_pub = sum(1 for p in posts if not p['upcoming'])
    n_up  = sum(1 for p in posts if p['upcoming'])
    print(f'  OK {listing.name} - {n_pub} published, {n_up} upcoming')


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    print('Building listings...')
    inject(ROOT / 'pages' / 'blog.html',      scan('posts'),     'Blog')
    inject(ROOT / 'pages' / 'technical.html', scan('technical'), 'Technical')
    print('Done.')
