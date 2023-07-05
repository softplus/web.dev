/*
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Imported just for types.
// eslint-disable-next-line no-unused-vars
const {Environment} = require('nunjucks');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const {findByUrl} = require('../../_filters/find-by-url');
const {exportFile} = require('../../_utils/export-file');
const {
  pluck,
  insert,
  MULTI_LINE_CODE_PATTERN,
  MULTI_LINE_CODE_PLACEHOLDER,
  INLINE_CODE_PATTERN,
  INLINE_CODE_PLACEHOLDER,
} = require('../../_utils/pluck-insert');
const authorValues = yaml.load(
  fs.readFileSync('./src/site/_data/i18n/authors.yml', 'utf-8'),
);

const NESTED_MULTI_LINE_CODE_PATTERN = new RegExp(
  '<div( .*)?>[\\s\\S]*?<\\/div>',
  'gi',
);

const RAW_SHORTCODE_PATTERN = /{% raw %}(.*?){% endraw %}/gm;
const RAW_PLACEHOLDER = 'RAW_PLACEHOLDER';

/**
 * Used to keep track of old URLs and their potential new URLs.
 */
const exportUrls = new Map();

function transform(markdown) {
  // Pluck out code snippets to not accidentally alter code examples
  const codeBlocks = [];
  markdown = pluck(
    codeBlocks,
    MULTI_LINE_CODE_PATTERN,
    MULTI_LINE_CODE_PLACEHOLDER,
    markdown,
  );
  const inlineCode = [];
  markdown = pluck(
    inlineCode,
    INLINE_CODE_PATTERN,
    INLINE_CODE_PLACEHOLDER,
    markdown,
  );

  // Remove the float-left and float-right classes as they are not used on web.dev
  // as of 06/23 both are not used literally so it's safe to omit a complex regex
  markdown = markdown.replace(
    /<figure class="float-(left|right)">/g,
    '<figure>',
  );

  // Add the webdev-caption class to all figcaptions - as of 06/23, no figcaption as other
  // custom classes, so a simple replace is enough
  markdown = markdown.replace(
    /<figcaption>/g,
    '<figcaption class="wd-caption">',
  );

  // Remove the screenshot class from figure elements as it has no effect on web.dev,
  // but would have on DevSite
  markdown = markdown.replace(/<figure class="screenshot">/g, '<figure>');

  // Rewrite the switcher class - as of 06/23 this class is not used with other classes,
  // so a simple replace is enough
  markdown = markdown.replace(/class="switcher"/g, 'class="wd-switcher"');

  // Prefix the stats class names with wd-
  markdown = markdown.replace(/class="stats/g, 'class="wd-stats');

  // Rewrite nested code blocks to <pre> blocks, as they are not rendered by DevSite
  markdown = markdown.replace(NESTED_MULTI_LINE_CODE_PATTERN, (match) => {
    return match.replace(
      new RegExp(`${MULTI_LINE_CODE_PLACEHOLDER}_(\\d+)`, 'g'),
      (match, index) => {
        let codeBlock = codeBlocks[index];
        codeBlock = codeBlock.replace(
          /```(.*?)$\n/gm,
          '<pre class="prettyprint lang-$1">{% htmlescape %}\n',
        );
        codeBlock = codeBlock.replace(/^```$/gm, '{% endhtmlescape %}</pre>');
        return codeBlock;
      },
    );
  });

  // Put remaining code blocks and snippets back into the transformed content
  markdown = insert(codeBlocks, MULTI_LINE_CODE_PLACEHOLDER, markdown);
  markdown = insert(inlineCode, INLINE_CODE_PLACEHOLDER, markdown);

  // Replace raw shortcodes with their verbatim DevSite equivalent
  markdown = markdown.replace(/{% raw %}/g, '{% verbatim %}');
  markdown = markdown.replace(/{% endraw %}/g, '{% endverbatim %}');

  return markdown;
}

/**
 * Renders content with Nunjucks instance configured in .eleventy.
 * This emulates pre-processing of the actual page content.
 *
 * @this {{env: Environment, ctx: Object}}
 */
async function Export() {
  // Need to re-retrieve the page from the collections.all array (which findByUrl uses)
  // as the page object from the context does not have the source content and environment.
  const pageUrl = this.ctx.page.url;
  const page = findByUrl(pageUrl);

  // The nunjucks env is not available in the context, so we need to dig it out
  // from 11ty internals
  const njkEnv =
    page.template._extensionMap._engineManager.engineCache.njk.njkEnv;

  const source = page?.template?.frontMatter?.content;
  if (!source) {
    return '';
  }

  const authors = page?.template?.frontMatter?.data.authors;
  let frontMatter = {
    project_path: '/_project.yaml',
    book_path: '/_book.yaml',
  };

  if (authors) {
    frontMatter.author_name = authorValues[authors[0]].title.en;
  }

  const description = page?.template?.frontMatter?.data.description;
  if (description) {
    frontMatter.description = description;
  }

  // Assume everything under learn is a course page
  if (this.ctx.page.url.startsWith('/learn')) {
    frontMatter.page_type = 'course';
  }

  // Convert the front matter object into a string
  frontMatter = Object.entries(frontMatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  const template = `${frontMatter}

{% import "/_macros.html" as macros %}
{% include "/_styles/style.md" %}

# ${this.ctx.title}
${
  authors
    ? `
{{ macros.Authors(${JSON.stringify(authors)}) }}
`
    : ''
}`;

  let transformedSource = source;
  // Raw shortcodes gone from the rendered template, but their content would still infer with DevSite.
  // Hence we need to pluck them out and re-insert them too.
  const rawShortcodes = [];
  transformedSource = pluck(
    rawShortcodes,
    RAW_SHORTCODE_PATTERN,
    RAW_PLACEHOLDER,
    transformedSource,
  );

  const tags = page?.template?.frontMatter?.data?.tags || [];

  // Determine a export path for the page, to dissolve the flat-file structure that
  // is currently used for web.dev
  const originalUrl = path.parse(this.ctx.page.url);
  let exportPath = originalUrl.dir;
  // Make sure exportPath has a trailing slash, to safely append path segments
  if (!exportPath.endsWith('/')) {
    exportPath = `${exportPath}/`;
  }

  if (tags.includes('case-study')) {
    exportPath += 'case-studies/';
  } else if (tags.includes('new-to-the-web')) {
    exportPath += 'blog/';
  } else if (exportPath === '/') {
    // Put everything else that would otherwise be in the root into the articles folder
    exportPath += 'articles/';
  }

  // Add the export path to the exportUrls map, so we can construct a redirect map
  exportUrls.set(this.ctx.page.url, `${exportPath}${originalUrl.name}`);
  console.log(this.ctx.page.url, `${exportPath}${originalUrl.name}`);

  const ctx = Object.assign({}, this.ctx, {export: true, exportPath});

  let markdown = await new Promise((resolve) => {
    console.log('Rendering template', pageUrl);
    njkEnv.renderString(transformedSource, ctx, (err, result) => {
      if (err) {
        resolve('Could not render template: ' + err);
        return;
      }

      resolve(result);
    });
  });

  // Put raw shortcodes back into the transformed content, they get then rewritten
  // to DevSite compatible `{% verbatim %}` tags in the transform method
  markdown = insert(rawShortcodes, RAW_PLACEHOLDER, markdown);

  const transformedMarkdown = template + transform(markdown);

  // Note: the following lines can be altered to produce any directory scheme
  // that is convenient for the migration
  await exportFile(ctx, transformedMarkdown);

  return transformedMarkdown;
}

module.exports = {Export, exportUrls, pluck, insert};
