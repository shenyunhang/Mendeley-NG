/** A browser User-Agent for endpoints that refuse scripted callers:
 *  Cloudflare in front of api.mendeley.com answers 1010 (and /oauth/token is
 *  no exception), and arXiv's Atom feed is fetched with it too.  One constant
 *  so the Mendeley client and the metadata lookup cannot drift apart. */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
