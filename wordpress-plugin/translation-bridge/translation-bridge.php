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
 * Yoast doesn't register these as REST meta, so PATCH /wp/v2/posts/{id}
 * with a "meta" object would silently drop them without this (confirmed
 * empirically during the phase-00 audit — see the plan doc).
 *
 * Deliberately NOT using register_post_meta() for these two: on the live
 * site (unlike the Yoast-less Playground test) Yoast SEO itself registers
 * these same keys with show_in_rest => false, loading after this plugin
 * (alphabetically "wordpress-seo" > "translation-bridge") and overriding
 * ours. register_rest_field() with its own field names sidesteps that
 * registry collision entirely — confirmed working on production.
 */
add_action( 'rest_api_init', 'tb_register_yoast_fields' );
function tb_register_yoast_fields() {
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
