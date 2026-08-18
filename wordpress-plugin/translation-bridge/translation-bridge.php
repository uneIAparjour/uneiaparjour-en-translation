<?php
/**
 * Plugin Name: Translation Bridge (Polylang + SEO)
 * Description: REST endpoint to link FR/EN post translations via Polylang, plus REST read/write access to Yoast SEO fields and translation-tracking meta that aren't exposed by default.
 * Version: 1.0.0
 * Requires PHP: 7.4
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Only edit_posts is required: the translation-bot account is an Author,
 * which already can't touch other users' posts, so this stays minimal
 * on purpose rather than checking a broader capability.
 */
function tb_can_manage_translations() {
	return current_user_can( 'edit_posts' );
}

add_action( 'rest_api_init', 'tb_register_rest_route' );
function tb_register_rest_route() {
	register_rest_route(
		'translation-bridge/v1',
		'/link',
		array(
			'methods'             => 'POST',
			'callback'            => 'tb_link_translations',
			'permission_callback' => 'tb_can_manage_translations',
			'args'                => array(
				'fr_id' => array(
					'required'          => true,
					'type'              => 'integer',
					'validate_callback' => function ( $value ) {
						return is_numeric( $value );
					},
				),
				'en_id' => array(
					'required'          => true,
					'type'              => 'integer',
					'validate_callback' => function ( $value ) {
						return is_numeric( $value );
					},
				),
			),
		)
	);

	// One-off migration helper (2026-08-17): the site's ~1329 existing FR
	// posts were all mistakenly tagged "en" in Polylang (it was configured
	// with English as the only/default language, never French). This lets
	// an admin-capable account bulk-correct that. Requires edit_others_posts
	// specifically — stricter than the other endpoints on purpose, since it
	// can touch any post, not just ones the caller owns.
	register_rest_route(
		'translation-bridge/v1',
		'/set-language',
		array(
			'methods'             => 'POST',
			'callback'            => 'tb_set_language',
			'permission_callback' => function () {
				return current_user_can( 'edit_others_posts' );
			},
			'args'                => array(
				'post_id' => array(
					'required'          => true,
					'type'              => 'integer',
					'validate_callback' => function ( $value ) {
						return is_numeric( $value );
					},
				),
				'lang'    => array(
					'required' => true,
					'type'     => 'string',
					'enum'     => array( 'fr', 'en' ),
				),
			),
		)
	);

	// Same fix as /set-language, but for taxonomy terms — the original
	// misconfiguration (English set as default before French was added)
	// also mislabeled every pre-existing category/tag as English, and that
	// was never corrected (only posts were, via /set-language above). Found
	// 2026-08-18 via a full categories audit: ~30 legacy categories/tags
	// (chatbot, images, video, etc., holding hundreds of French posts each)
	// are still tagged "en" in Polylang. Same permission level as
	// /set-language since it's the same class of bulk site-wide fix.
	register_rest_route(
		'translation-bridge/v1',
		'/set-term-language',
		array(
			'methods'             => 'POST',
			'callback'            => 'tb_set_term_language',
			'permission_callback' => function () {
				return current_user_can( 'edit_others_posts' );
			},
			'args'                => array(
				'term_id' => array(
					'required'          => true,
					'type'              => 'integer',
					'validate_callback' => function ( $value ) {
						return is_numeric( $value );
					},
				),
				'lang'    => array(
					'required' => true,
					'type'     => 'string',
					'enum'     => array( 'fr', 'en' ),
				),
			),
		)
	);
}

function tb_set_term_language( WP_REST_Request $request ) {
	if ( ! function_exists( 'pll_set_term_language' ) ) {
		return new WP_Error( 'polylang_missing', 'Polylang is not active or its functions are unavailable.', array( 'status' => 500 ) );
	}

	$term_id = (int) $request->get_param( 'term_id' );
	$lang    = $request->get_param( 'lang' );

	if ( ! get_term( $term_id ) ) {
		return new WP_Error( 'invalid_term', "Term {$term_id} does not exist.", array( 'status' => 404 ) );
	}

	pll_set_term_language( $term_id, $lang );

	return new WP_REST_Response( array( 'success' => true, 'term_id' => $term_id, 'lang' => $lang ), 200 );
}

function tb_set_language( WP_REST_Request $request ) {
	if ( ! function_exists( 'pll_set_post_language' ) ) {
		return new WP_Error( 'polylang_missing', 'Polylang is not active or its functions are unavailable.', array( 'status' => 500 ) );
	}

	$post_id = (int) $request->get_param( 'post_id' );
	$lang    = $request->get_param( 'lang' );

	if ( ! get_post( $post_id ) ) {
		return new WP_Error( 'invalid_post', "Post {$post_id} does not exist.", array( 'status' => 404 ) );
	}

	pll_set_post_language( $post_id, $lang );

	return new WP_REST_Response( array( 'success' => true, 'post_id' => $post_id, 'lang' => $lang ), 200 );
}

/**
 * translation-bot is an Author, which can assign existing categories/tags
 * to its own posts but — correctly, by WordPress default — cannot create
 * new taxonomy terms via the standard /wp/v2/categories REST endpoint
 * (rest_cannot_create, found during the first live test). This lets the
 * script get-or-create an EN term through our own gated endpoint instead
 * of needing a broader WP capability grant on the account itself.
 */
add_action( 'rest_api_init', 'tb_register_term_route' );
function tb_register_term_route() {
	register_rest_route(
		'translation-bridge/v1',
		'/create-term',
		array(
			'methods'             => 'POST',
			'callback'            => 'tb_create_term',
			'permission_callback' => 'tb_can_manage_translations',
			'args'                => array(
				'taxonomy'    => array(
					'required' => true,
					'type'     => 'string',
					'enum'     => array( 'category', 'post_tag' ),
				),
				'name'        => array(
					'required' => true,
					'type'     => 'string',
				),
				// Optional: the FR term this EN term is a translation of —
				// when given, links them via Polylang so term archive pages
				// and the language switcher work, instead of leaving new EN
				// terms orphaned (a known v1 gap, closed 2026-08-18).
				'fr_term_id'  => array(
					'required' => false,
					'type'     => 'integer',
				),
			),
		)
	);

	// Read-only audit used by the one-off category/tag language cleanup
	// (2026-08-18): lists every term in a taxonomy with its real Polylang
	// language and linked translations, so the migration script works from
	// ground truth instead of guessing from names/slugs.
	register_rest_route(
		'translation-bridge/v1',
		'/term-audit',
		array(
			'methods'             => 'GET',
			'callback'            => 'tb_term_audit',
			'permission_callback' => 'tb_can_manage_translations',
			'args'                => array(
				'taxonomy' => array(
					'required' => true,
					'type'     => 'string',
					'enum'     => array( 'category', 'post_tag' ),
				),
			),
		)
	);

	// Companion to the cleanup above: deletes leftover empty duplicate terms
	// (0 posts) created by the pre-fix version of /create-term, which didn't
	// set a language and could produce orphaned junk terms. Same permission
	// level as the other bulk-migration endpoints. Refuses server-side if
	// the term isn't actually empty, regardless of what the caller checked.
	register_rest_route(
		'translation-bridge/v1',
		'/delete-term',
		array(
			'methods'             => 'POST',
			'callback'            => 'tb_delete_term',
			'permission_callback' => function () {
				return current_user_can( 'edit_others_posts' );
			},
			'args'                => array(
				'term_id'  => array(
					'required'          => true,
					'type'              => 'integer',
					'validate_callback' => function ( $value ) {
						return is_numeric( $value );
					},
				),
				'taxonomy' => array(
					'required' => true,
					'type'     => 'string',
					'enum'     => array( 'category', 'post_tag' ),
				),
			),
		)
	);
}

function tb_term_audit( WP_REST_Request $request ) {
	$taxonomy = $request->get_param( 'taxonomy' );

	$terms = get_terms(
		array(
			'taxonomy'   => $taxonomy,
			'hide_empty' => false,
		)
	);

	if ( is_wp_error( $terms ) ) {
		return new WP_Error( 'term_audit_failed', $terms->get_error_message(), array( 'status' => 500 ) );
	}

	$rows = array();
	foreach ( $terms as $term ) {
		$rows[] = array(
			'term_id'      => $term->term_id,
			'name'         => $term->name,
			'slug'         => $term->slug,
			'count'        => (int) $term->count,
			'lang'         => function_exists( 'pll_get_term_language' ) ? pll_get_term_language( $term->term_id ) : null,
			'translations' => function_exists( 'pll_get_term_translations' ) ? pll_get_term_translations( $term->term_id ) : array(),
		);
	}

	return new WP_REST_Response( $rows, 200 );
}

function tb_delete_term( WP_REST_Request $request ) {
	$term_id  = (int) $request->get_param( 'term_id' );
	$taxonomy = $request->get_param( 'taxonomy' );

	$term = get_term( $term_id, $taxonomy );
	if ( ! $term || is_wp_error( $term ) ) {
		return new WP_Error( 'invalid_term', "Term {$term_id} does not exist in {$taxonomy}.", array( 'status' => 404 ) );
	}

	// Server-side safety net, independent of whatever the caller already
	// checked: never delete a term that still has posts attached.
	if ( (int) $term->count > 0 ) {
		return new WP_Error( 'term_not_empty', "Term {$term_id} still has {$term->count} post(s) attached — refusing to delete.", array( 'status' => 409 ) );
	}

	$result = wp_delete_term( $term_id, $taxonomy );
	if ( is_wp_error( $result ) ) {
		return new WP_Error( 'term_delete_failed', $result->get_error_message(), array( 'status' => 500 ) );
	}
	// wp_delete_term() returns 0 (not WP_Error) when refusing to delete the
	// taxonomy's default term (e.g. "Uncategorized") — falsy either way,
	// caught by a loose check rather than strict `false === $result`.
	if ( ! $result ) {
		return new WP_Error( 'term_delete_failed', 'WordPress refused to delete this term (possibly the default category).', array( 'status' => 500 ) );
	}

	return new WP_REST_Response( array( 'success' => true, 'term_id' => $term_id ), 200 );
}

function tb_create_term( WP_REST_Request $request ) {
	$taxonomy   = $request->get_param( 'taxonomy' );
	$name       = $request->get_param( 'name' );
	$fr_term_id = $request->get_param( 'fr_term_id' );

	// A plain name lookup ignores language entirely, which used to merge new
	// EN posts into old, same-named categories that were actually still
	// French underneath (found 2026-08-18: legacy categories/tags predating
	// proper Polylang setup are mislabeled "en" site-wide, see
	// /set-term-language above). Only reuse an existing term if it's
	// confirmed to actually be English already — otherwise a French term
	// with an identical translated name (e.g. "chatbot", "images",
	// "application") would get silently reused for EN content too.
	$existing = get_term_by( 'name', $name, $taxonomy );
	$is_usable_existing = $existing
		&& function_exists( 'pll_get_term_language' )
		&& 'en' === pll_get_term_language( $existing->term_id );

	if ( $is_usable_existing ) {
		$term_id = $existing->term_id;
		$created = false;
	} else {
		$result = wp_insert_term( $name, $taxonomy );
		if ( is_wp_error( $result ) && 'term_exists' === $result->get_error_code() ) {
			// WordPress itself refuses two terms with the identical display
			// name under the same parent, independent of Polylang and of the
			// slug — hit live 2026-08-18 once legacy categories were
			// relabelled back to "fr" (e.g. "images" the category still
			// existed in French, blocking a same-named English one). An
			// explicit, unique slug sidesteps it; the visible name is
			// untouched, so it still displays correctly in English.
			$slug   = sanitize_title( $name ) . '-en-' . ( $fr_term_id ? (int) $fr_term_id : $name );
			$result = wp_insert_term( $name, $taxonomy, array( 'slug' => $slug ) );
		}
		if ( is_wp_error( $result ) ) {
			return new WP_Error( 'term_creation_failed', $result->get_error_message(), array( 'status' => 500 ) );
		}
		$term_id = $result['term_id'];
		$created = true;
	}

	if ( function_exists( 'pll_set_term_language' ) ) {
		pll_set_term_language( $term_id, 'en' );
	}

	if ( $fr_term_id && function_exists( 'pll_save_term_translations' ) ) {
		pll_save_term_translations(
			array(
				'fr' => (int) $fr_term_id,
				'en' => $term_id,
			)
		);
	}

	return new WP_REST_Response( array( 'success' => true, 'term_id' => $term_id, 'created' => $created ), 200 );
}

/**
 * Links an FR post and an EN post as Polylang translations of each other.
 * Idempotent: calling it again with the same pair is a no-op, not a duplicate link.
 */
function tb_link_translations( WP_REST_Request $request ) {
	if ( ! function_exists( 'pll_set_post_language' ) || ! function_exists( 'pll_save_post_translations' ) ) {
		return new WP_Error( 'polylang_missing', 'Polylang is not active or its functions are unavailable.', array( 'status' => 500 ) );
	}

	$fr_id = (int) $request->get_param( 'fr_id' );
	$en_id = (int) $request->get_param( 'en_id' );

	if ( ! get_post( $fr_id ) ) {
		return new WP_Error( 'invalid_fr_post', "FR post {$fr_id} does not exist.", array( 'status' => 404 ) );
	}
	if ( ! get_post( $en_id ) ) {
		return new WP_Error( 'invalid_en_post', "EN post {$en_id} does not exist.", array( 'status' => 404 ) );
	}

	pll_set_post_language( $fr_id, 'fr' );
	pll_set_post_language( $en_id, 'en' );

	pll_save_post_translations(
		array(
			'fr' => $fr_id,
			'en' => $en_id,
		)
	);

	return new WP_REST_Response(
		array(
			'success' => true,
			'fr_id'   => $fr_id,
			'en_id'   => $en_id,
		),
		200
	);
}

/**
 * Custom REST fields not exposed by WordPress/Yoast by default: the two
 * Yoast SEO fields, plus (below) a stable raw-content field for hashing.
 *
 * Yoast doesn't register yoast_title/yoast_metadesc as REST meta, so PATCH
 * /wp/v2/posts/{id} with a "meta" object would silently drop them without
 * this (confirmed empirically during the phase-00 audit — see the plan
 * doc). Deliberately NOT using register_post_meta() for these two: on the
 * live site (unlike the Yoast-less Playground test) Yoast SEO itself
 * registers these same keys with show_in_rest => false, loading after this
 * plugin (alphabetically "wordpress-seo" > "translation-bridge") and
 * overriding ours. register_rest_field() with its own field names
 * sidesteps that registry collision entirely — confirmed working on
 * production.
 */
add_action( 'rest_api_init', 'tb_register_custom_rest_fields' );
function tb_register_custom_rest_fields() {
	register_rest_field(
		'post',
		'yoast_title',
		array(
			'get_callback'    => function ( $post ) {
				return get_post_meta( $post['id'], '_yoast_wpseo_title', true );
			},
			'update_callback' => function ( $value, $post ) {
				if ( ! current_user_can( 'edit_post', $post->ID ) ) {
					return new WP_Error( 'rest_forbidden', 'Not allowed to edit this post.', array( 'status' => 403 ) );
				}
				return update_post_meta( $post->ID, '_yoast_wpseo_title', sanitize_text_field( $value ) );
			},
			'schema'          => array(
				'type'        => 'string',
				'description' => 'Yoast SEO title (bypasses register_meta to avoid a collision with Yoast\'s own registration).',
				'context'     => array( 'view', 'edit' ),
			),
		)
	);

	register_rest_field(
		'post',
		'yoast_metadesc',
		array(
			'get_callback'    => function ( $post ) {
				return get_post_meta( $post['id'], '_yoast_wpseo_metadesc', true );
			},
			'update_callback' => function ( $value, $post ) {
				if ( ! current_user_can( 'edit_post', $post->ID ) ) {
					return new WP_Error( 'rest_forbidden', 'Not allowed to edit this post.', array( 'status' => 403 ) );
				}
				return update_post_meta( $post->ID, '_yoast_wpseo_metadesc', sanitize_text_field( $value ) );
			},
			'schema'          => array(
				'type'        => 'string',
				'description' => 'Yoast SEO meta description (bypasses register_meta to avoid a collision with Yoast\'s own registration).',
				'context'     => array( 'view', 'edit' ),
			),
		)
	);

	/**
	 * content.rendered is unstable between requests for the same unchanged
	 * post — WordPress core's Image block lightbox feature (and possibly
	 * others) injects randomized IDs/attributes at render time, so a
	 * content-hash computed from it never matches between runs, defeating
	 * change detection entirely (found during live testing: every post
	 * looked "changed" on every run). content.raw (WP's own ?context=edit)
	 * would be stable, but requires edit_post on that specific post, which
	 * translation-bot (Author) doesn't have for posts it doesn't own. This
	 * exposes the raw, unfiltered post_content directly — stable, and
	 * gated the same way as the other custom fields, not by ownership.
	 */
	register_rest_field(
		'post',
		'raw_content',
		array(
			'get_callback' => function ( $post ) {
				return get_post_field( 'post_content', $post['id'] );
			},
			'schema'       => array(
				'type'        => 'string',
				'description' => 'Raw, unfiltered post_content — stable across requests, unlike content.rendered. Used for change-detection hashing, not for translation input.',
				'context'     => array( 'view', 'edit' ),
			),
		)
	);
}

add_action( 'init', 'tb_register_post_meta' );
function tb_register_post_meta() {
	// Content hash of the FR source at the time it was last translated —
	// lets the sync script detect real changes instead of trusting modified-date.
	register_post_meta(
		'post',
		'_translation_source_hash',
		array(
			'type'          => 'string',
			'single'        => true,
			'show_in_rest'  => true,
			'auth_callback' => 'tb_can_manage_translations',
		)
	);

	// If true, the EN post was edited by hand after translation and must
	// never be silently overwritten by a later automated resync.
	register_post_meta(
		'post',
		'_translation_locked',
		array(
			'type'          => 'boolean',
			'single'        => true,
			'show_in_rest'  => true,
			'auth_callback' => 'tb_can_manage_translations',
		)
	);
}

/**
 * The site tagline (Réglages > Général > Slogan) is a single global WP
 * option, not made translatable by Polylang's string-translation system
 * (unlike the theme/plugin strings registered via pll_register_string()).
 * Swap it for the English version when the current language is "en".
 */
add_filter( 'option_blogdescription', 'tb_translate_tagline' );
function tb_translate_tagline( $value ) {
	if ( function_exists( 'pll_current_language' ) && 'en' === pll_current_language() ) {
		return 'One day, one generative AI tool.';
	}
	return $value;
}
